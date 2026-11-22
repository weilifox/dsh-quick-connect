/**
 * dsh-quick-connect — Amazon Quick chat quota as a DeepSeek Harness provider.
 *
 * What this module is responsible for:
 *
 * - reading the Quick desktop app's sign-in from Windows Credential Manager
 *   (read-only) and minting fresh access tokens through the standard AWS SSO
 *   OIDC endpoint;
 * - exposing Quick's four routing tiers (fast / balanced / smart / advanced)
 *   as selectable models; each model id maps 1:1 to the `agent_mode` field
 *   Quick's cloud agent routes by;
 * - reporting account + usage (`session` / `monthly` minutes) over a small
 *   loopback status route for the settings card.
 *
 * Since 0.2.0 it also relays Quick's device tools: the plugin boots Quick's
 * own `quickwork-agent.exe --outpost-only`, declares that outpost on every
 * chat turn (so the cloud counts the turn as device-originated) and answers
 * `tool_call` frames through the outpost's local `/local/invoke_tool`.
 *
 * What it deliberately does NOT do:
 * - write anything to Quick's storage. Credential Manager stays Quick's sole
 *   write domain; the OIDC-refresh's rotated refresh_token lives in memory
 *   only and is discarded on restart.
 *
 * @module dsh-quick-connect
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { QuickCredentialStore, readActiveProfile } from "./creds.js";
import { quickChatApi, SUPPORTED_MODES } from "./gateway.js";
import { QuickOutpost } from "./outpost.js";
import { fetchUsage, describeSubscription } from "./usage.js";

/** Cordis plugin name for the provider entry (`llm-quick` in cordis.patch.yml). */
export const name = "llm-quick";
/** The llm service is all this plugin needs from the host to register a route. */
export const inject = ["llm"];

const PROVIDER_ID = "quick";
const PROVIDER_DISPLAY_NAME = "Amazon Quick";
const SETTINGS_NS = "quick";
const PLUGIN_VERSION = "0.3.0";

/** Plugin-owned read-only status endpoint consumed by the settings card. */
export const QUICK_STATUS_PATH = "/plugins/dsh-quick-connect/status";
/** Manual actions (refresh). Loopback-only; performs no privileged writes. */
export const QUICK_ACTION_PATH = "/plugins/dsh-quick-connect/action";

const CREDENTIAL_POLL_MS = 30_000;
const USAGE_POLL_MS = 120_000;

const MODE_META = {
	fast: { name: "Quick · 快（Fast）", description: "最省时长，路由到轻量模型（实测 claude-haiku-5.5）" },
	balanced: { name: "Quick · 标准（Balanced）", description: "均衡档" },
	smart: { name: "Quick · 智能（Smart）", description: "默认推荐档" },
	advanced: { name: "Quick · 高级（Advanced）", description: "最强档，时长消耗最快" }
};

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Inert pi-ai auth plane — the route authenticates solely through
 * `resolveApiKey`, so pi-ai's own credential lifecycle must never
 * manufacture state.
 */
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-quick-connect: the Quick route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};

//#region helpers

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function isoOf(ms) {
	return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

//#endregion
//#region catalog

/**
 * The four Quick routing tiers. ids equal the wire `agent_mode` values, so
 * stream dispatch needs no translation.
 */
export function buildCatalogRows() {
	return SUPPORTED_MODES.map((mode) => ({
		id: mode,
		name: MODE_META[mode].name,
		description: MODE_META[mode].description,
		input: ["text"],
		reasoning: mode === "smart" || mode === "advanced"
	}));
}

export class QuickCatalog {
	models = [];
	shown = true;

	set(models) {
		this.models = models;
	}

	current() {
		return this.shown ? this.models : [];
	}

	hide() {
		this.shown = false;
	}

	show() {
		this.shown = true;
	}
}

//#endregion
//#region adapter

export function toPiModel(row, tenantUrl, providerId = PROVIDER_ID) {
	return {
		id: row.id,
		name: row.name,
		api: "quick-chat",
		provider: providerId,
		baseUrl: tenantUrl,
		input: ["text"],
		reasoning: row.reasoning === true,
		cost: NO_COST,
		// Quick's cloud agent has a large transcript window; the tier is what
		// governs quality, not a context ceiling we control.
		contextWindow: 200_000,
		maxTokens: 8_192
	};
}

/**
 * Assemble the adapter. The tenant URL is re-resolved per read: the profile
 * can change (Quick-side re-login) without rebuilding the provider object.
 */
export function createQuickAdapter(options) {
	const { catalog, store, config, runtime } = options;
	const buildModels = () => {
		// Tenant priority: explicit setting > the profile's tenant_url resolved
		// by the last sweep. Both are https origins; empty → the API refuses
		// with a clear "tenant URL not ready" instead of dialing a bogus host.
		const tenant = config().tenantUrl?.trim() || runtime?.tenantUrl || undefined;
		const proxy = store.activeProxy ?? undefined;
		return catalog.current().map((row) => {
			const model = toPiModel(row, tenant);
			// pi-ai forwards the model object into stream(); carry the tunnel on
			// it so the chat plane dials through the same proxy the store picked.
			model.quickProxy = proxy;
			// Tool bridge switch (text protocol; see gateway.js).
			model.quickToolBridge = config()?.toolBridge !== false;
			// Device bridge: the local outpost id + invoker. `prepare()` boots
			// the agent (idempotent) so the payload can carry its id.
			model.quickDevice = {
				get outpostId() {
					return runtime?.outpost?.outpostId;
				},
				appVersion: config()?.appVersion?.trim() || undefined,
				prepare: () => ensureOutpost(runtime),
				invoke: async (toolName, args, timeoutMs) => {
					const outpost = await ensureOutpost(runtime);
					if (!outpost?.ready) return { ok: false, result: null, error: outpost?.error ?? "本机代理未就绪" };
					return outpost.invoke(toolName, args, timeoutMs);
				},
				// Ring buffer of the last turn's protocol events, surfaced in the
				// status route so a truncated reply can be diagnosed after the fact.
				record: (event) => {
					const log = runtime.turnLog ?? (runtime.turnLog = []);
					log.push(compactTurnEvent(event));
					if (log.length > 240) log.splice(0, log.length - 240);
				}
			};
			return model;
		});
	};
	const provider = {
		...createProvider({
			id: PROVIDER_ID,
			name: PROVIDER_DISPLAY_NAME,
			auth: {
				apiKey: {
					name: "Quick access token",
					// pi-ai throws "Provider is not configured: <id>" whenever this
					// resolution comes back empty, so the token has to be produced
					// here and not only through the adapter's resolveApiKey seam.
					async resolve() {
						try {
							const token = await store.resolveToken();
							return { auth: { apiKey: token }, source: "Quick credential manager + OIDC" };
						} catch {
							return undefined;
						}
					}
				}
			},
			models: buildModels(),
			api: { "quick-chat": quickChatApi() }
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: PROVIDER_ID,
		displayName: PROVIDER_DISPLAY_NAME,
		// Long turns are normal: Quick's cloud agent plans and answers over tens
		// of seconds; idle-timeout guards the socket, not the turn.
		streamIdleTimeoutMs: 600_000,
		retryPolicy: resolveRetryPolicy(undefined, "dsh-quick-connect retryPolicy"),
		configuredMaxTokens: new Map(),
		modelErrors: new Map(),
		cacheRetention: "none",
		piProvider: provider
	};
	let profiles = new Map([[PROVIDER_ID, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => store.resolveToken()
		}),
		// Exposed for scripts/self-check: the exact model descriptors the host
		// would receive, including quickProxy and quickDevice.
		models: buildModels,
		invalidate: () => {
			profiles = new Map([[PROVIDER_ID, profile]]);
		}
	};
}

//#endregion
//#region runtime + sweep

export function createRuntime(config, current) {
	const store = new QuickCredentialStore({
		profilesFile: config.profilesFile?.trim() || undefined,
		region: config.oidcRegion?.trim() || undefined,
		proxy: config.proxy?.trim() || undefined
	});
	const catalog = new QuickCatalog();
	catalog.set(buildCatalogRows());
	return {
		store,
		catalog,
		profile: undefined,
		tenantUrl: undefined,
		activeProxy: null,
		outpost: undefined,
		usage: undefined,
		usageError: undefined,
		lastUsageAt: 0,
		lastSweep: 0,
		turnLog: [],
		current,
		status: { status: "signed-out" },
		error: undefined
	};
}

/**
 * Boot (once) the local device agent and register the configured folders.
 * Returns undefined when local tools are switched off.
 */
export async function ensureOutpost(runtime) {
	const config = runtime.current();
	if (config?.localTools === false) return undefined;
	let outpost = runtime.outpost;
	if (!outpost) {
		outpost = new QuickOutpost({
			exePath: config?.outpostExe?.trim() || "",
			port: Number(config?.outpostPort ?? 0)
		});
		runtime.outpost = outpost;
	}
	if (!outpost.ready) {
		const info = await outpost.ensure();
		if (!info) return outpost;
	}
	const folders = String(config?.allowedFolders ?? "")
		.split(/[\n;]+/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	// Default to the host's working directory plus the workspaces DSH keeps in
	// ~/.dsh/sessions so device file tools work out of the box (the harness
	// process itself runs from the profile dir, not from the workspace).
	if (folders.length === 0) folders.push(process.cwd(), ...recentWorkspaceFolders());
	for (const folder of folders) {
		const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
		if (outpost.allowedFolders.has(normalized)) continue;
		try {
			await outpost.addAllowedFolder(normalized);
		} catch {
			// A folder that cannot be registered (deleted, locked) must not take
			// the whole device bridge down; the rest stay usable.
		}
	}
	return outpost;
}

/** Align visibility with the credential (hidden while unusable). */
export function adoptIdentity(runtime, credential) {
	const usable = credential?.status === "signed-in";
	if (usable) {
		// Publish the resolved tenant + the tunnel route for buildModels().
		runtime.tenantUrl = credential.tenantUrl;
		runtime.activeProxy = runtime.store.activeProxy ?? null;
		runtime.catalog.show();
		return;
	}
	runtime.tenantUrl = undefined;
	runtime.activeProxy = null;
	runtime.catalog.hide();
}

/** One poll: credential + identity + tenant refresh + periodic usage. */
export async function sweep(runtime, options = {}) {
	const credential = await runtime.store.current();
	runtime.status = credential;
	adoptIdentity(runtime, credential);
	if (!usable(credential)) {
		runtime.error = credential.message;
		return;
	}
	runtime.error = undefined;
	runtime.profile = credential.profile;
	const configuredTenant = runtime.current().tenantUrl?.trim();
	if (configuredTenant) credential.tenantUrl = configuredTenant.replace(/\/+$/, "");
	if (options.usage !== false || runtime.usage === undefined) {
		await refreshUsage(runtime, credential).catch(() => {});
	}
	runtime.lastSweep = Date.now();
}

function usable(credential) {
	return credential?.status === "signed-in" && typeof credential.token === "string" && typeof credential.tenantUrl === "string";
}

/** Best-effort usage refresh; failures land in `usageError`, never throw. */
export async function refreshUsage(runtime, credential) {
	try {
		const token = credential.token;
		const tenantUrl = credential.tenantUrl ?? runtime.tenantUrl;
		const proxyUrl = runtime.store.activeProxy ?? undefined;
		if (!token || !tenantUrl) return;
		const usage = await fetchUsage({ tenantUrl, token, proxyUrl });
		runtime.usage = usage;
		runtime.usageError = undefined;
		runtime.lastUsageAt = Date.now();
	} catch (error) {
		runtime.usageError = errorMessage(error);
	}
}

//#endregion
//#region status document

export function buildStatus(runtime) {
	const config = runtime.current();
	const status = runtime.status ?? {};
	const usage = runtime.usage;
	const session = usage?.session;
	const monthly = usage?.monthly;
	return {
		plugin: { name: "dsh-quick-connect", version: PLUGIN_VERSION },
		provider: { id: PROVIDER_ID, displayName: PROVIDER_DISPLAY_NAME },
		status: {
			status: status.status ?? "signed-out",
			...(status.email === undefined ? {} : { email: status.email }),
			...(status.displayName === undefined ? {} : { displayName: status.displayName }),
			...(status.role === undefined ? {} : { role: status.role }),
			...(status.profile === undefined ? {} : { profileId: status.profile.id }),
			...(status.tenantUrl === undefined ? {} : { tenantUrl: status.tenantUrl }),
			...(status.expiresAtMs === undefined ? {} : { tokenExpiresAt: isoOf(status.expiresAtMs) }),
			...(status.message === undefined ? {} : { message: status.message })
		},
		usage:
			session && monthly
				? {
						session: { used: session.used, limit: session.limit, percent: session.percent, resetsAt: isoOf((session.resets_at ?? 0) * 1000) },
						monthly: { used: monthly.used, limit: monthly.limit, percent: monthly.percent, resetsAt: isoOf((monthly.resets_at ?? 0) * 1000) },
						subscription: describeSubscription(usage),
						checkedAt: isoOf(runtime.lastUsageAt),
						...(runtime.usageError === undefined ? {} : { error: runtime.usageError })
					}
				: {
						unavailable: true,
						...(runtime.usageError === undefined ? {} : { error: runtime.usageError })
					},
		localTools: buildLocalToolsStatus(runtime),
		recentEvents: (runtime.turnLog ?? []).slice(-40),
		catalog: { shown: runtime.catalog.shown, count: runtime.catalog.models.length },
		models: runtime.catalog.models.map((row) => ({ id: row.id, name: row.name, reasoning: row.reasoning })),
		...(runtime.profile === undefined ? {} : { tenantUrl: runtime.profile.tenantUrl }),
		...(config.tenantUrl?.trim() ? { tenantUrlOverride: config.tenantUrl.trim() } : {}),
		...(runtime.error === undefined ? {} : { message: runtime.error })
	};
}

/**
 * `--C-Users-me-Projects-demo--` → `C:\Users\me\Projects\demo`.
 *
 * DSH encodes the workspace path by replacing every `\` with `-`, which is
 * ambiguous when the path itself contains a `-` (a folder named `my-project` does). So we
 * enumerate the candidate splits and keep the first one that exists on disk.
 */
function decodeWorkspaceDir(name) {
	if (!name.startsWith("--") || !name.endsWith("--")) return undefined;
	const inner = name.slice(2, -2).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
	if (!/^[A-Za-z]-/.test(inner)) return undefined;
	const parts = inner.slice(2).split("-");
	if (parts.length > 9) return undefined; // 2^8 combinations is plenty
	const drive = `${inner[0]}:`;
	let found;
	const walk = (index, acc) => {
		if (found) return;
		if (index === parts.length) {
			const candidate = `${drive}\\${acc.join("\\")}`;
			try {
				if (statSync(candidate).isDirectory()) found = candidate;
			} catch {
				/* keep trying */
			}
			return;
		}
		const part = parts[index];
		walk(index + 1, [...acc, part]);
		if (part.length > 0) {
			// also try joining this segment with the previous one via a literal '-'
			if (acc.length > 0) {
				const merged = [...acc.slice(0, -1), `${acc[acc.length - 1]}-${part}`];
				walk(index + 1, merged);
			}
		}
	};
	walk(0, []);
	return found;
}

/** The most recently used DSH workspaces (they are what users point file tools at). */
function recentWorkspaceFolders(limit = 3) {
	const root = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
	let names;
	try {
		names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
	const ranked = names
		.map((name) => {
			const folder = decodeWorkspaceDir(name);
			if (!folder) return undefined;
			try {
				if (!statSync(folder).isDirectory()) return undefined;
			} catch {
				return undefined;
			}
			let mtime = 0;
			try {
				mtime = statSync(join(root, name)).mtimeMs;
			} catch {
				/* ignore */
			}
			return { folder, mtime };
		})
		.filter(Boolean)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit);
	return ranked.map((entry) => entry.folder);
}

function compactTurnEvent(event) {
	const type = typeof event?.type === "string" ? event.type : "unknown";
	const payload = event?.payload;
	let brief;
	try {
		brief = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
	} catch {
		brief = "";
	}
	if (brief.length > 180) brief = `${brief.slice(0, 180)}…`;
	return `${type} ${brief}`.trim();
}

function buildLocalToolsStatus(runtime) {
	const config = runtime.current();
	const outpost = runtime.outpost;
	const enabled = config?.localTools !== false;
	if (!enabled) return { enabled: false, state: "disabled" };
	if (!outpost) return { enabled: true, state: "idle" };
	return {
		enabled: true,
		state: outpost.state,
		...(outpost.error === undefined ? {} : { error: outpost.error }),
		...(outpost.outpostId === undefined ? {} : { outpostId: outpost.outpostId }),
		...(outpost.outpostName === undefined ? {} : { outpostName: outpost.outpostName }),
		...(outpost.info === undefined ? {} : { toolCount: outpost.info.toolCount, groups: outpost.info.groups }),
		allowedFolders: [...outpost.allowedFolders],
		invocations: outpost.invocations
	};
}

//#endregion
//#region routes

function isLoopbackHost(host) {
	if (typeof host !== "string") return true;
	const [name] = host.split(":");
	const trimmed = name.trim().toLowerCase();
	return trimmed === "127.0.0.1" || trimmed === "localhost" || trimmed === "[::1]" || trimmed === "::1";
}

function isLoopbackOrigin(origin) {
	if (origin === undefined) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

function sendJson(res, statusCode, body) {
	const text = JSON.stringify(body);
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store"
	});
	res.end(text);
}

async function readBody(req, limit) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error(`request body exceeds ${limit} bytes`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function registerQuickRoutes(web, runtime) {
	const statusDispose = web.register({
		kind: "exact",
		path: QUICK_STATUS_PATH,
		handler: async (req, res) => {
			if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
				sendJson(res, 403, { status: "error", message: "quick: loopback origin required" });
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				sendJson(res, 405, { status: "error", message: "quick: status is read-only" });
				return;
			}
			runtime.status = await runtime.store.current();
			sendJson(res, 200, buildStatus(runtime));
		}
	});
	const actionDispose = web.register({
		kind: "exact",
		path: QUICK_ACTION_PATH,
		handler: async (req, res) => {
			if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
				sendJson(res, 403, { status: "error", message: "quick: loopback origin required" });
				return;
			}
			if (req.method !== "POST") {
				sendJson(res, 405, { status: "error", message: "quick: actions are POST-only" });
				return;
			}
			let action;
			try {
				const parsed = JSON.parse(await readBody(req, 4_096));
				action = parsed?.action;
				if (action !== "refresh" && action !== "refresh-usage" && action !== "outpost-restart") throw new Error("action must be refresh|refresh-usage|outpost-restart");
			} catch (error) {
				sendJson(res, 400, { status: "error", message: `quick: ${errorMessage(error)}` });
				return;
			}
			try {
				runtime.store.invalidateProfile();
				runtime.status = await runtime.store.current();
				adoptIdentity(runtime, runtime.status);
				if (action === "outpost-restart") {
					runtime.outpost?.stop();
					runtime.outpost = undefined;
					await ensureOutpost(runtime).catch(() => {});
					sendJson(res, 200, { status: "ok", ...buildStatus(runtime) });
					return;
				}
				if (action === "refresh-usage") {
					await refreshUsage(runtime, runtime.status);
				} else {
					await sweep(runtime, { usage: false });
					await refreshUsage(runtime, runtime.status);
				}
				sendJson(res, 200, { status: "ok", ...buildStatus(runtime) });
			} catch (error) {
				sendJson(res, 500, { status: "error", message: errorMessage(error) });
			}
		}
	});
	return () => {
		statusDispose();
		actionDispose();
	};
}

//#endregion
//#region plugin

const PROFILES_FILE_FIELD = z.string().default("").description("Quick profiles.json 路径（留空 = ~/.quickwork/profiles.json）");
const TENANT_URL_FIELD = z.string().default("").description("覆盖 tenant URL（留空 = 用 profiles.json 里当前 profile 的 tenant_url）");
const OIDC_REGION_FIELD = z.string().default("").description("AWS SSO OIDC 区域（留空 = us-east-1）");
const PROXY_FIELD = z.string().default("").description("HTTP 代理（留空 = 自动探测 127.0.0.1:7897/7890/10809/8888）");
const USAGE_MINUTES_FIELD = z.number().default(2).description("用量刷新间隔（分钟）");
const LOCAL_TOOLS_FIELD = z.boolean().default(true).description("允许 Quick 调用本机工具（文件 / Python / 浏览器）");
const ALLOWED_FOLDERS_FIELD = z.string().default("").description("允许 Quick 读写的本机目录（每行一个，留空 = 用 DSH 工作目录）");
const OUTPOST_EXE_FIELD = z.string().default("").description("quickwork-agent.exe 路径（留空 = 自动查找 Quick 安装目录）");
const OUTPOST_PORT_FIELD = z.number().default(0).description("本机代理端口（0 = 自动分配）");
const APP_VERSION_FIELD = z.string().default("").description("上报给 Quick 的桌面端版本（留空 = 1.2.4660）");
const TOOL_BRIDGE_FIELD = z.boolean().default(true).description("让 Quick 通过文本协议调用 DSH 的工具（关闭后 Quick 只能聊天）");

export const Config = z.object({
	profilesFile: PROFILES_FILE_FIELD,
	tenantUrl: TENANT_URL_FIELD,
	oidcRegion: OIDC_REGION_FIELD,
	proxy: PROXY_FIELD,
	usageMinutes: USAGE_MINUTES_FIELD,
	localTools: LOCAL_TOOLS_FIELD,
	allowedFolders: ALLOWED_FOLDERS_FIELD,
	outpostExe: OUTPOST_EXE_FIELD,
	outpostPort: OUTPOST_PORT_FIELD,
	appVersion: APP_VERSION_FIELD,
	toolBridge: TOOL_BRIDGE_FIELD
});

async function bootstrap(ctx, runtime) {
	const adapter = createQuickAdapter({
		catalog: runtime.catalog,
		store: runtime.store,
		runtime,
		config: () => runtime.current()
	});
	runtime.invalidate = () => {
		adapter.invalidate();
		ctx.emit("llm/adapters-updated");
	};
	let releaseAdapter;
	let releaseDirectory;
	try {
		releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter.adapter);
		releaseDirectory = ctx.llm.registerConfigurableProviders([
			{
				provider: PROVIDER_ID,
				displayName: PROVIDER_DISPLAY_NAME,
				settingsNs: SETTINGS_NS,
				settingsPath: [],
				declared: false
			}
		]);
	} catch (error) {
		releaseAdapter?.();
		releaseDirectory?.();
		throw error;
	}
	return () => {
		releaseDirectory?.();
		releaseAdapter?.();
	};
}

/** Cordis entry point. */
export function apply(ctx, config) {
	let current = () => config;
	const runtime = createRuntime(config, () => current());
	const timers = [];
	let stopped = false;
	let disposeRegistration;

	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.configure({ auto: true });
	});

	ctx.inject(["webServer"], (webCtx) => {
		const dispose = registerQuickRoutes(webCtx.webServer, runtime);
		return () => dispose();
	});

	const start = async () => {
		try {
			disposeRegistration = await bootstrap(ctx, runtime);
		} catch (error) {
			ctx.logger.error("dsh-quick-connect: provider registration failed", error);
			return;
		}
		if (stopped) {
			disposeRegistration();
			return;
		}
		await sweep(runtime).catch((error) => ctx.logger.error("dsh-quick-connect: initial sweep failed", error));
		// Prewarm the device agent: its boot takes ~10 s, so start it once the
		// credential is known instead of on the first chat turn.
		if (runtime.status?.status === "signed-in" && current().localTools !== false) {
			ensureOutpost(runtime).catch((error) => ctx.logger.warn("dsh-quick-connect: outpost prewarm failed", error));
		}
		timers.push(
			setInterval(() => {
				sweep(runtime, { usage: false }).catch((error) => ctx.logger.error("dsh-quick-connect: credential sweep failed", error));
			}, CREDENTIAL_POLL_MS)
		);
		const usageMinutes = Math.min(Math.max(Number(current().usageMinutes ?? 2), 1), 60);
		timers.push(
			setInterval(() => {
				refreshUsage(runtime, runtime.status).catch((error) => ctx.logger.error("dsh-quick-connect: usage refresh failed", error));
			}, usageMinutes * 60_000)
		);
	};

	start();

	ctx.effect(() => () => {
		stopped = true;
		runtime.outpost?.stop();
		for (const timer of timers) clearInterval(timer);
		timers.length = 0;
		disposeRegistration?.();
	});
}

//#endregion
