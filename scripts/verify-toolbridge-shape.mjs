#!/usr/bin/env node
/**
 * Reproduces the pi-ai transcript shape that DSH actually hands us: tools are
 * NOT in context.tools, they live on a leading system message as `toolsAdded`
 * (normalizeContext folds them there). Asserts the bridge still engages.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const imports = (spec) => import(pathToFileURL(join(here, "..", spec)).href);

const creds = await imports("lib/creds.js");
const gateway = await imports("lib/gateway.js");

const store = new creds.QuickCredentialStore();
const session = await store.current();
if (session.status !== "signed-in") {
	console.error("not signed in:", session.message);
	process.exit(1);
}

const tools = [
	{
		name: "dsh_bash",
		description: "在本机执行一条 shell 命令并返回输出",
		parameters: {
			type: "object",
			properties: { command: { type: "string", description: "命令" } },
			required: ["command"]
		}
	}
];

// Exactly what pi-ai's normalizeContext() produces for a DSH request.
const messages = [
	{ role: "system", content: "You are a helpful assistant.", toolsAdded: tools, timestamp: 0 },
	{ role: "user", content: "列出 D:\\DSH-WorkSpace\\设置类 下最新的 5 个文件夹", timestamp: 1 }
];

const api = gateway.quickChatApi();
const model = { id: "fast", api: "quick-chat", provider: "quick", baseUrl: session.tenantUrl, quickToolBridge: true };

const result = await api
	.stream(model, { messages }, {
		apiKey: session.token,
		sessionId: `dsh-shape-${Date.now().toString(36)}-0000-0000-0000-000000000000`,
		quickProxy: store.activeProxy ?? undefined
	})
	.result();

const calls = (result?.content ?? []).filter((block) => block.type === "toolCall");
const text = (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");

console.log("stopReason:", result?.stopReason);
console.log("toolCalls:", JSON.stringify(calls.map((call) => ({ name: call.name, arguments: call.arguments }))));
console.log("text:", text.slice(0, 200));
console.log("errorMessage:", result?.errorMessage);

const ok = result?.stopReason === "toolUse" && calls.length > 0;
console.log(ok ? "TRANSCRIPT-SHAPE: PASS" : "TRANSCRIPT-SHAPE: FAIL");
process.exit(ok ? 0 : 1);
