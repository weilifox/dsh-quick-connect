/**
 * dsh-quick-connect credential plane.
 *
 * Read-only with respect to Amazon Quick's own storage:
 *
 * - profile metadata comes from `~/.quickwork/profiles.json` (which profile is
 *   active, its provider and tenant_url);
 * - the OAuth blob lives in Windows Credential Manager under
 *   `quickwork-<provider>-<profileId>` (+ `_chunk_N` when it exceeds one
 *   entry); this module only ever calls CredRead;
 * - a fresh access token is minted with the standard AWS SSO OIDC CreateToken
 *   call (`https://oidc.<region>.amazonaws.com/token`, grantType
 *   `refresh_token`) — the same public API Quick's own outpost uses. Nothing
 *   is written back to Credential Manager: Quick stays the sole writer.
 *
 * The OIDC refresh response carries a rotated refresh_token. It is kept in
 * memory only, so subsequent refreshes in the same DSH session chain off the
 * rotated value while Quick itself is signed in; after a Quick-side
 * re-login the credential blob is re-read and takes precedence.
 *
 * @module lib/creds
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { URL } from "node:url";

const execFileAsync = promisify(execFile);

/**
 * Egress helpers. The Quick tenant host (`*.dp.appintegrations.*.plato.ai.aws.dev`)
 * is not on public DNS — Quick's own Electron network service reaches it
 * through a local proxy. Node's fetch ignores system proxy settings, so the
 * plugin dials through an HTTP CONNECT tunnel: the configured proxy when one
 * is set, otherwise the common local mixed-port proxies in order.
 */
const KNOWN_LOCAL_PROXIES = ["http://127.0.0.1:7897", "http://127.0.0.1:7890", "http://127.0.0.1:10809", "http://127.0.0.1:8888"];

//#region proxy detection

export function proxyCandidates(configured) {
	const list = [];
	const config = typeof configured === "string" ? configured.trim() : "";
	const envProxy = process.env.QUICK_CONNECT_PROXY?.trim() || process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
	if (config) list.push(config);
	if (envProxy) list.push(envProxy);
	list.push(...KNOWN_LOCAL_PROXIES);
	return list;
}

/**
 * Whether `hostname` resolves without a proxy. The tenant family is
 * DNS-dark by design; one probe decides the egress route.
 */
export async function hostNeedsProxy(hostname, timeoutMs = 4_000) {
	try {
		const { lookup } = await import("node:dns/promises");
		const result = await Promise.race([
			lookup(hostname),
			new Promise((resolve, reject) => setTimeout(() => reject(new Error("dns timeout")), timeoutMs))
		]);
		return !result?.address;
	} catch {
		return true;
	}
}

/** Probe one CONNECT proxy with a short timeout. */
export function proxyReachable(proxyUrl, timeoutMs = 2_500) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const url = new URL(proxyUrl);
			const request = httpRequest({
				host: url.hostname,
				port: Number(url.port || 80),
				method: "CONNECT",
				path: "example.invalid:443",
				timeout: timeoutMs
			});
			request.on("connect", (response, socket) => {
				socket.destroy();
				done(response.statusCode === 200);
			});
			request.on("timeout", () => {
				request.destroy();
				done(false);
			});
			request.on("error", () => done(false));
			request.end();
		} catch {
			done(false);
		}
	});
}

/**
 * Pick the first working proxy from the candidate chain. Result is memoized
 * per store; `null` means "no proxy needed / none available → direct".
 */
export async function resolveProxy(configured) {
	for (const candidate of proxyCandidates(configured)) {
		if (await proxyReachable(candidate)) return candidate;
	}
	return null;
}

//#endregion
//#region CONNECT tunnel fetch

/**
 * fetch() over an HTTP CONNECT tunnel — for hosts that only resolve through
 * the proxy. Mirrors the fetch signature the rest of the plugin uses.
 */
export function tunneledFetch(url, init = {}, proxyUrl) {
	if (!proxyUrl) return fetch(url, init);
	const target = new URL(url);
	const proxy = new URL(proxyUrl);
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			host: proxy.hostname,
			port: Number(proxy.port || 80),
			method: "CONNECT",
			path: `${target.hostname}:${target.port || 443}`,
			headers: { host: `${target.hostname}:${target.port || 443}` }
		});
		request.on("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(Object.assign(new Error(`proxy CONNECT failed: ${response.statusCode}`), { code: "proxy_connect_failed" }));
				return;
			}
			performTlsRequest(socket, target, init)
				.then(resolve)
				.catch(reject);
		});
		request.on("error", reject);
		request.setTimeout(10_000, () => {
			request.destroy();
			reject(Object.assign(new Error("proxy CONNECT timeout"), { code: "proxy_timeout" }));
		});
		request.end();
	});
}

/** Minimal HTTPS-over-socket request. */
function performTlsRequest(socket, target, init) {
	return new Promise((resolve, reject) => {
		const tls = tlsConnect(
			{ socket, servername: target.hostname, host: target.hostname, port: Number(target.port || 443) },
			() => {
				const body = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : init.body ? Buffer.from(init.body) : undefined;
				const headers = { host: target.hostname, connection: "close", ...(init.headers ?? {}) };
				if (body && !headers["content-length"]) headers["content-length"] = String(body.length);
				const lines = [
					`${init.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`,
					...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
				];
				tls.write(lines.join("\r\n") + "\r\n\r\n");
				if (body) tls.write(body);
				const chunks = [];
				tls.on("data", (chunk) => chunks.push(chunk));
				tls.on("end", () => {
					const raw = Buffer.concat(chunks).toString("latin1");
					const split = raw.indexOf("\r\n\r\n");
					const head = raw.slice(0, split);
					const bodyText = raw.slice(split + 4);
					const status = Number(head.split("\r\n")[0].split(" ")[1] || 0);
					resolve({
						ok: status >= 200 && status < 300,
						status,
						text: async () => bodyText,
						json: async () => JSON.parse(bodyText)
					});
				});
				tls.on("error", reject);
			}
		);
		tls.setTimeout(15_000, () => {
			tls.destroy();
			reject(Object.assign(new Error("TLS request timeout"), { code: "tls_timeout" }));
		});
	});
}

/** Access tokens are proactively renewed this close to expiry. */
export const EXPIRY_MARGIN_MS = 5 * 60_000;
/** Refresh happens at most this often even under error storms. */
export const MIN_REFRESH_INTERVAL_MS = 30_000;
/** OIDC call timeout. */
const OIDC_TIMEOUT_MS = 15_000;
/** CredRead / PowerShell timeout. */
const CRED_TIMEOUT_MS = 15_000;
/** Profiles.json read cadence (tenant_url rarely changes). */
const PROFILES_POLL_MS = 60_000;

//#region profiles.json

/**
 * Read `~/.quickwork/profiles.json` and return the active profile's identity.
 *
 * Shape (verified 2026-11-21): `{version, entries:[{id, provider,
 * display_name, data_path, login_metadata:{issuer_url, tenant_url, client_id},
 * created_at, last_used_at, refresh_failing_since}], last_active}`.
 */
export async function readActiveProfile(profilesFile) {
	const file = profilesFile ?? join(homedir(), ".quickwork", "profiles.json");
	let document;
	try {
		document = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
	const entries = Array.isArray(document?.entries) ? document.entries : [];
	if (entries.length === 0) return undefined;
	const lastActive = document.last_active;
	const active =
		entries.find((entry) => entry?.id === lastActive) ??
		entries.reduce((best, entry) => {
			const a = Date.parse(entry?.last_used_at ?? 0) || 0;
			const b = Date.parse(best?.last_used_at ?? 0) || 0;
			return a > b ? entry : best;
		}, entries[0]);
	if (!active?.id) return undefined;
	const meta = active.login_metadata ?? {};
	return {
		profileId: String(active.id),
		provider: String(active.provider ?? "social"),
		displayName: typeof active.display_name === "string" ? active.display_name : undefined,
		tenantUrl: typeof meta.tenant_url === "string" && meta.tenant_url.length > 0 ? meta.tenant_url.replace(/\/+$/, "") : undefined,
		issuerUrl: typeof meta.issuer_url === "string" ? meta.issuer_url : undefined,
		clientId: typeof meta.client_id === "string" ? meta.client_id : undefined,
		sourcePath: file,
		readAt: Date.now()
	};
}

/** A poller that re-reads profiles.json at most once per interval. */
export function createProfileWatcher(options = {}) {
	let memo;
	let lastRead = 0;
	return {
		async current() {
			const now = Date.now();
			if (memo && now - lastRead < PROFILES_POLL_MS) return memo;
			const fresh = await readActiveProfile(options.profilesFile);
			if (fresh) {
				memo = fresh;
				lastRead = now;
			} else if (!memo || now - lastRead > PROFILES_POLL_MS) {
				// File gone/corrupt: forget a stale identity after one interval.
				memo = undefined;
				lastRead = now;
			}
			return memo;
		},
		invalidate() {
			memo = undefined;
			lastRead = 0;
		}
	};
}

//#endregion
//#region Credential Manager (read-only)

/**
 * PowerShell helper source. CredRead through a typed struct — the inline
 * MemberDefinition variant crashes with AccessViolation when hand-decoding
 * the pointer layout.
 */
const PS_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshQuickCredMan {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);
    [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
    public static string ReadBlob(string target) {
        IntPtr p;
        if (!CredRead(target, 1, 0, out p)) return "ERR:" + Marshal.GetLastWin32Error().ToString();
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        byte[] buf = new byte[c.CredentialBlobSize];
        if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, buf, 0, c.CredentialBlobSize);
        CredFree(p);
        return Encoding.Unicode.GetString(buf);
    }
}
`;

const PS_TEMPLATE = (targets) => `
$src = @'
${PS_SOURCE}
'@
Add-Type -TypeDefinition $src -Language CSharp
$results = @()
${targets
	.map(
		(target, index) =>
			`$r${index} = [DshQuickCredMan]::ReadBlob('${target}')\n` +
			`if (-not \$r${index}.StartsWith('ERR:')) { Write-Output ('===BEGIN:${target}==='); Write-Output \$r${index}; Write-Output '===END===' }`
	)
	.join("\n")}
`;

/**
 * Read one Credential Manager blob. Returns the decoded string or undefined
 * when the entry does not exist (error 1168) or PowerShell is unavailable.
 */
export async function readCredentialBlob(target) {
	const script = `$src = @'\n${PS_SOURCE}\n'@\nAdd-Type -TypeDefinition $src -Language CSharp\n[DshQuickCredMan]::ReadBlob('${target}')`;
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ timeout: CRED_TIMEOUT_MS, windowsHide: true }
		);
		const text = stdout ?? "";
		if (text.startsWith("ERR:")) return undefined;
		return text.replace(/\r?\n$/, "");
	} catch {
		return undefined;
	}
}

/**
 * Assemble the profile's credential document from the base entry and its
 * `_chunk_N` parts.
 *
 * Verified shape (2026-11-21): the base entry is a tiny JSON
 * `{"__chunks__":N,"__sha__":"…"}`; the payload is split across
 * `<target>_chunk_0…N-1` in order. Blobs are UTF-16.
 */
export async function readQuickCredential(profileId, provider = "social") {
	const base = `quickwork-${provider}-${profileId}`;
	const baseBlob = await readCredentialBlob(base);
	if (baseBlob === undefined) return undefined;
	let text = baseBlob;
	const trimmed = baseBlob.trim();
	if (trimmed.startsWith("{") && trimmed.includes("__chunks__")) {
		try {
			const meta = JSON.parse(trimmed);
			const chunks = Number(meta.__chunks__ ?? 0);
			if (!Number.isInteger(chunks) || chunks <= 0 || chunks > 64) return undefined;
			const parts = [];
			for (let index = 0; index < chunks; index += 1) {
				const part = await readCredentialBlob(`${base}_chunk_${index}`);
				if (part === undefined) return undefined;
				parts.push(part);
			}
			text = parts.join("");
		} catch {
			return undefined;
		}
	}
	try {
		const document = JSON.parse(text);
		return typeof document === "object" && document !== null ? document : undefined;
	} catch {
		return undefined;
	}
}

//#endregion
//#region OIDC refresh

/**
 * Derive the AWS SSO OIDC issuer host from the portal issuer URL.
 *
 * Quick's `issuer_url` is the Identity Center portal
 * (`https://identitycenter.amazonaws.com/ssoins-…`); the token endpoint lives
 * on the regional OIDC host, not the portal host — POSTing to the portal host
 * itself is refused by CloudFront (verified 2026-11-21). The profile id of a
 * social identity is `us-east-1` (client_id suffix `-dXMtZWFzdC0x`); allow an
 * explicit override for other regions.
 */
export function oidcTokenUrl(issuerUrl, regionOverride) {
	const region = regionOverride?.trim() || "us-east-1";
	return `https://oidc.${region}.amazonaws.com/token`;
}

/**
 * One CreateToken refresh. Returns the full OIDC response:
 * `{accessToken, expiresIn, refreshToken?, idToken?, issuedTokenType,
 * tokenType, …}`.
 */
export async function refreshAccessToken(options) {
	const body = JSON.stringify({
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		grantType: "refresh_token",
		refreshToken: options.refreshToken
	});
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OIDC_TIMEOUT_MS);
	try {
		// The OIDC host is public DNS; plain fetch is correct here regardless of
		// whether the tenant needs a tunnel.
		const response = await fetch(options.tokenUrl, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body,
			signal: controller.signal
		});
		const text = await response.text();
		if (!response.ok) {
			let detail = text.slice(0, 200);
			try {
				const parsed = JSON.parse(text);
				detail = parsed.error ?? detail;
			} catch {}
			const error = new Error(`OIDC refresh failed: HTTP ${response.status} ${detail}`);
			error.code = "oidc_refresh_failed";
			error.status = response.status;
			throw error;
		}
		const parsed = JSON.parse(text);
		if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
			throw Object.assign(new Error("OIDC refresh response has no accessToken"), { code: "oidc_bad_response" });
		}
		return parsed;
	} finally {
		clearTimeout(timer);
	}
}

//#endregion
//#region session store

/**
 * In-memory SNCS session:
 *
 * - `accessToken`/`expiresAtMs` — the OIDC bearer used against the tenant;
 * - `refreshToken` — the rotated value from the last refresh (memory only).
 *
 * Resolution order each `current()` call:
 * 1. memoized valid token (margin applied);
 * 2. read the credential document, refresh with its refresh_token;
 * 3. on 400/403 from OIDC (rotated token superseded by Quick's own refresh),
 *    retry once with the credential's stored value — the same value Quick
 *    wrote, which is exactly what its outpost uses.
 */
export class QuickCredentialStore {
	#watcher;
	#regionOverride;
	#proxyUrl;
	#activeProxy;
	#memo;
	#inflight;
	#lastRefreshAt = 0;

	constructor(options = {}) {
		this.#watcher = options.profiles ?? createProfileWatcher({ profilesFile: options.profilesFile });
		this.#regionOverride = options.region;
		this.#proxyUrl = typeof options.proxy === "string" ? options.proxy : undefined;
	}

	/** The CONNECT tunnel in use after the last refresh (or null for direct). */
	get activeProxy() {
		return this.#activeProxy ?? null;
	}

	/** The active profile identity (memoized read of profiles.json). */
	profile() {
		return this.#watcher.current();
	}

	invalidateProfile() {
		this.#watcher.invalidate();
	}

	#credentialFresh(document) {
		return (
			typeof document?.refresh_token === "string" &&
			document.refresh_token.length > 0 &&
			typeof document?.client_id === "string" &&
			typeof document?.client_secret === "string"
		);
	}

	async #loadCredential() {
		const profile = await this.profile();
		if (!profile) return undefined;
		const document = await readQuickCredential(profile.profileId, profile.provider);
		if (!this.#credentialFresh(document)) return undefined;
		return { profile, document };
	}

	/**
	 * A usable session or a structured refusal. Never throws for expected
	 * states (not signed in, OIDC down); unexpected errors are also reported
	 * through the `error` field so the status card can show them.
	 */
	async current() {
		try {
			const loaded = await this.#loadCredential();
			if (!loaded) {
				return {
					status: "signed-out",
					message: "未找到 Quick 凭据（需要先登录 Quick 桌面端一次）"
				};
			}
			const { profile, document } = loaded;
			const cached = this.#memo;
			const usable =
				cached &&
				cached.profileId === profile.profileId &&
				typeof cached.accessToken === "string" &&
				cached.expiresAtMs - EXPIRY_MARGIN_MS > Date.now();
			if (usable) {
				return {
					status: "signed-in",
					token: cached.accessToken,
					profile,
					accountId: typeof document.aws_account_id === "string" ? document.aws_account_id : undefined,
					email: typeof document.email === "string" ? document.email : undefined,
					displayName: typeof document.display_name === "string" ? document.display_name : profile.displayName,
					role: typeof document.role === "string" ? document.role : undefined,
					subscription: typeof document.role === "string" ? document.role : undefined,
					tenantUrl: profile.tenantUrl,
					expiresAtMs: cached.expiresAtMs,
					sourcePath: `credential:${profile.provider}/${profile.profileId}`
				};
			}
			const session = await this.#refresh(profile, document);
			return {
				status: "signed-in",
				token: session.accessToken,
				profile,
				accountId: typeof document.aws_account_id === "string" ? document.aws_account_id : undefined,
				email: typeof document.email === "string" ? document.email : undefined,
				displayName: typeof document.display_name === "string" ? document.display_name : profile.displayName,
				role: typeof document.role === "string" ? document.role : undefined,
				tenantUrl: profile.tenantUrl,
				expiresAtMs: session.expiresAtMs,
				sourcePath: `credential:${profile.provider}/${profile.profileId}`
			};
		} catch (error) {
			return {
				status: "error",
				message: error instanceof Error ? error.message : String(error)
			};
		}
	}

	async #refresh(profile, document) {
		const now = Date.now();
		const since = now - this.#lastRefreshAt;
		if (since < MIN_REFRESH_INTERVAL_MS && this.#memo && this.#memo.profileId === profile.profileId) {
			return this.#memo;
		}
		if (this.#inflight) return this.#inflight;
		this.#inflight = (async () => {
			// Egress route: the tenant host is DNS-dark; when a local proxy answers
			// CONNECT, the tunnel is memoized for usage + WSS too.
			const tenantHost = profile.tenantUrl?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
			const needsProxy = tenantHost ? await hostNeedsProxy(tenantHost) : false;
			this.#activeProxy = needsProxy ? await resolveProxy(this.#proxyUrl) : null;
			const attempts = [];
			const cached = this.#memo && this.#memo.profileId === profile.profileId ? this.#memo.refreshToken : undefined;
			if (cached) attempts.push(cached);
			attempts.push(document.refresh_token);
			let lastError;
			for (const refreshToken of attempts) {
				try {
					const response = await refreshAccessToken({
						tokenUrl: oidcTokenUrl(profile.issuerUrl, this.#regionOverride),
						clientId: document.client_id,
						clientSecret: document.client_secret,
						refreshToken
					});
					const ttl = Number(response.expiresIn ?? 3600) * 1000;
					const session = {
						profileId: profile.profileId,
						accessToken: response.accessToken,
						refreshToken: typeof response.refreshToken === "string" && response.refreshToken.length > 0 ? response.refreshToken : refreshToken,
						expiresAtMs: Date.now() + ttl
					};
					this.#memo = session;
					this.#lastRefreshAt = Date.now();
					return session;
				} catch (error) {
					lastError = error;
				}
			}
			this.#lastRefreshAt = Date.now();
			throw lastError ?? new Error("OIDC refresh failed");
		})();
		try {
			return await this.#inflight;
		} finally {
			this.#inflight = undefined;
		}
	}

	/** The bearer token for request paths; throws only on hard errors. */
	async resolveToken() {
		const session = await this.current();
		if (session.status !== "signed-in") {
			const error = new Error(session.message ?? "Quick session unavailable");
			error.code = "missing_credential";
			throw error;
		}
		return session.token;
	}
}

//#endregion
