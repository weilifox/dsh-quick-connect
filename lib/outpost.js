/**
 * Local outpost bridge — the device side of Quick's tool loop.
 *
 * Amazon Quick's desktop app does not execute tools itself. A separate Python
 * agent (`quickwork-agent.exe --outpost-only`) listens on loopback and exposes
 * `/local/invoke_tool`; the Electron main process forwards every `tool_call`
 * frame that arrives over the chat websocket to that endpoint and answers with
 * a `tool_result` frame. The cloud only routes those frames to a turn that is
 * attributed to a device — which is why the chat payload must carry the
 * outpost id (see gateway.js).
 *
 * This module owns that agent process: discovery, boot, the instance token,
 * the loopback HTTP calls, and a bounded restart policy. It writes nothing
 * outside the agent's own storage; the allowed-folders list is the agent's own
 * (unchanged) security gate.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";

const BOOT_TIMEOUT_MS = 90_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/** The desktop app truncates relayed results at this many bytes. */
export const MAX_RELAY_BYTES = 250_000;

function isFile(path) {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

/** Resolve the shipped agent binary + its resource root. */
export function resolveAgentPaths(overrideExe = "", overrideResources = "") {
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const exeCandidates = [
		overrideExe,
		process.env.QUICKWORK_AGENT_EXE,
		localAppData && join(localAppData, "quickwork", "agent", "quickwork-agent.exe")
	].filter((value) => typeof value === "string" && value.length > 0);
	const resourcesCandidates = [
		overrideResources,
		process.env.QUICKWORK_RESOURCES_PATH,
		localAppData && join(localAppData, "Programs", "quickwork", "resources")
	].filter((value) => typeof value === "string" && value.length > 0);
	return {
		exe: exeCandidates.find(isFile),
		resources: resourcesCandidates.find((path) => isFile(join(path, "app.asar")))
	};
}

function freePort() {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(0));
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Loopback JSON call. The agent only speaks to 127.0.0.1, never through a proxy. */
function loopbackRequest(port, method, path, token, body, timeoutMs) {
	return new Promise((resolve) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				timeout: timeoutMs,
				headers: {
					authorization: `Bearer ${token}`,
					...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
				}
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json;
					try {
						json = JSON.parse(text);
					} catch {}
					resolve({ status: response.statusCode ?? 0, text, json });
				});
			}
		);
		request.on("error", (error) => resolve({ status: 0, text: error.message }));
		request.on("timeout", () => {
			request.destroy();
			resolve({ status: 0, text: "outpost request timeout" });
		});
		if (payload) request.write(payload);
		request.end();
	});
}

/** Keep a relayed result under the desktop app's byte ceiling. */
export function clampRelayResult(value) {
	const text = JSON.stringify(value ?? null);
	if (Buffer.byteLength(text, "utf8") <= MAX_RELAY_BYTES) return { value, text };
	const marker = "\n…[TRUNCATED — result too large for device relay]";
	const keep = Math.floor((MAX_RELAY_BYTES - 400) / 4);
	return {
		value: `${text.slice(0, keep)}${marker}`,
		text: "clamped"
	};
}

/**
 * One device agent. `ensure()` boots it once and reuses the process; the
 * instance token is a fresh 32-byte hex value handed over on stdin, exactly
 * like the desktop app does, and it is never persisted.
 */
export class QuickOutpost {
	/** @type {"stopped"|"starting"|"ready"|"failed"} */
	state = "stopped";
	info = undefined;
	error = undefined;
	allowedFolders = new Set();
	invocations = 0;

	constructor(options = {}) {
		this.exePath = options.exePath ?? "";
		this.resourcesPath = options.resourcesPath ?? "";
		this.preferredPort = Number(options.port ?? 0);
		this.log = options.log ?? (() => {});
		this.child = undefined;
		this.token = undefined;
		this.port = 0;
		this.pending = undefined;
	}

	get ready() {
		return this.state === "ready" && this.info !== undefined;
	}

	get outpostId() {
		return this.info?.outpostId;
	}

	get outpostName() {
		return this.info?.outpostName;
	}

	/** Boot (or reuse) the agent. Concurrent callers share one boot. */
	async ensure() {
		if (this.ready) return this.info;
		if (this.pending) return this.pending;
		this.pending = this.start().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	async start() {
		const { exe, resources } = resolveAgentPaths(this.exePath, this.resourcesPath);
		if (!exe) {
			this.state = "failed";
			this.error = "未找到 Quick 本机代理（quickwork-agent.exe）。请先安装并登录 Quick 桌面端。";
			return undefined;
		}
		this.state = "starting";
		this.error = undefined;
		const port = this.preferredPort > 0 ? this.preferredPort : await freePort();
		const token = crypto.randomBytes(32).toString("hex");
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const child = spawn(exe, ["--outpost-only", "--manifest", "desktop", "--port", String(port)], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				QUICKWORK_BUILD_STAGE: process.env.QUICKWORK_BUILD_STAGE ?? "prod",
				...(resources ? { QUICKWORK_RESOURCES_PATH: resources } : {}),
				QUICKWORK_NODE_PATH: process.execPath,
				PYTHONUTF8: "1",
				...(localAppData ? { QUICKWORK_EXTRACTED_PATH: join(localAppData, "quickwork") } : {})
			}
		});
		this.child = child;
		this.token = token;
		this.port = port;
		child.stdin?.write(`${token}\n`);
		let stderrTail = "";
		child.stderr?.on("data", (chunk) => {
			stderrTail = (stderrTail + String(chunk)).slice(-4_000);
		});
		child.stdout?.on("data", () => {});
		child.once("exit", (code) => {
			const wasReady = this.state === "ready";
			this.state = "failed";
			this.info = undefined;
			this.child = undefined;
			this.error = `Quick 本机代理已退出（code=${code}）`;
			if (wasReady) this.log(`outpost exited code=${code}`);
		});

		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.child === undefined) {
				this.error = `Quick 本机代理启动失败：${stderrTail.split("\n").filter(Boolean).slice(-3).join(" | ") || "进程已退出"}`;
				this.state = "failed";
				return undefined;
			}
			const response = await loopbackRequest(port, "GET", "/local/device-tools", token, undefined, 3_000);
			if (response.status === 200 && response.json?.outpostId) {
				this.info = {
					outpostId: response.json.outpostId,
					outpostName: response.json.outpostName,
					groups: Object.keys(response.json.tools ?? {}),
					toolCount: Object.values(response.json.tools ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
				};
				this.state = "ready";
				this.error = undefined;
				this.log(`outpost ready id=${this.info.outpostId} name=${this.info.outpostName}`);
				return this.info;
			}
			await sleep(400);
		}
		this.state = "failed";
		this.error = "Quick 本机代理启动超时";
		return undefined;
	}

	/** Register a directory in the agent's allowed-folders list (idempotent). */
	async addAllowedFolder(folder) {
		if (!this.ready || typeof folder !== "string" || folder.trim().length === 0) return false;
		const normalized = folder.trim().replace(/\\/g, "/").replace(/\/+$/, "");
		const response = await loopbackRequest(this.port, "POST", "/local/allowed_folders", this.token, { path: normalized }, 15_000);
		const ok = response.status === 200 && response.json?.success !== false;
		if (ok) this.allowedFolders.add(normalized);
		return ok;
	}

	/** Ask the agent's own path validator (cloud-mode normalisation). */
	async validatePath(path) {
		if (!this.ready) return undefined;
		const response = await loopbackRequest(this.port, "POST", "/local/validate_path", this.token, { path }, 10_000);
		return response.json;
	}

	/**
	 * Execute one cloud-issued tool call on this machine.
	 * Returns `{ ok, result, error }` in the shape the relay expects.
	 */
	async invoke(toolName, args, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
		if (!this.ready) return { ok: false, result: null, error: this.error ?? "outpost not ready" };
		const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 600_000) : DEFAULT_TOOL_TIMEOUT_MS;
		const toolCallId = crypto.randomUUID();
		const response = await loopbackRequest(
			this.port,
			"POST",
			"/local/invoke_tool",
			this.token,
			{
				tool_name: toolName,
				arguments: args ?? {},
				wire_paths: true,
				tool_call_id: toolCallId,
				request_timeout_ms: budget
			},
			budget + 15_000
		);
		this.invocations += 1;
		if (response.status === 200 && response.json !== undefined) {
			const failed = response.json?.success === false || (typeof response.json?.status === "string" && response.json.status === "error");
			return { ok: !failed, result: response.json, error: failed ? String(response.json?.error ?? response.json?.message ?? "tool failed") : null };
		}
		return { ok: false, result: null, error: `outpost HTTP ${response.status}: ${String(response.text ?? "").slice(0, 400)}` };
	}

	stop() {
		const child = this.child;
		this.child = undefined;
		this.state = "stopped";
		this.info = undefined;
		if (child && child.exitCode === null) {
			try {
				child.kill();
			} catch {}
		}
	}
}
