#!/usr/bin/env node
/**
 * Live verification of the tool bridge (v0.3.0).
 *
 * Round 1: the model is given one declared tool and no DSH tool loop; it must
 * answer with a single JSON execution request → the adapter must emit a
 * toolCall block with stopReason "toolUse".
 * Round 2: the real file content is fed back as a toolResult; the model must
 * answer from it (proving the round trip closes).
 *
 * Usage: node scripts/verify-toolbridge.mjs [--mode=fast|balanced|smart|advanced]
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const imports = (spec) => import(pathToFileURL(join(here, "..", spec)).href);

const mode = (() => {
	const flag = process.argv.find((arg) => arg.startsWith("--mode="));
	const value = flag?.split("=")[1];
	return ["fast", "balanced", "smart", "advanced"].includes(value) ? value : "fast";
})();

const creds = await imports("lib/creds.js");
const gateway = await imports("lib/gateway.js");

const target = join(here, "..", "package.json");
const ask = `读一下 ${target}，告诉我 name 和 version。`;

const tools = [
	{
		name: "dsh_workspace_read",
		description: "读取 DSH 工作区文件内容",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "绝对路径" } },
			required: ["path"]
		}
	}
];

const store = new creds.QuickCredentialStore();
const session = await store.current();
if (session.status !== "signed-in") {
	console.error("not signed in:", session.message);
	process.exit(1);
}

const api = gateway.quickChatApi();
const call = async (messages) => {
	const model = { id: mode, api: "quick-chat", provider: "quick", baseUrl: session.tenantUrl, quickToolBridge: true };
	const stream = api.stream(model, { messages, tools }, {
		apiKey: session.token,
		sessionId: `dsh-bridge-${Date.now().toString(36)}-0000-0000-0000-000000000000`,
		quickProxy: store.activeProxy ?? undefined
	});
	return stream.result();
};

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
};

//#region round 1 — the model must ask for the tool
const first = await call([
	{ role: "system", content: "You are a careful assistant." },
	{ role: "user", content: ask }
]);
const firstCall = (first.content ?? []).find((block) => block.type === "toolCall");
check("round 1: stop reason is toolUse", first.stopReason === "toolUse", `stopReason=${first.stopReason}${first.errorMessage ? ` (${first.errorMessage})` : ""}`);
check("round 1: a toolCall block came back", Boolean(firstCall), firstCall ? `${firstCall.name} ${JSON.stringify(firstCall.arguments)}` : "none");

if (!firstCall) {
	console.log("\nverify-toolbridge: FAILED (no tool call)");
	process.exit(1);
}

//#region round 2 — feed the real result back
let fileText = "";
try {
	fileText = readFileSync(firstCall.arguments?.path ?? target, "utf8");
} catch (error) {
	fileText = `Error: ${error.message}`;
}
let expected = {};
try {
	expected = JSON.parse(fileText);
} catch {}

const second = await call([
	{ role: "system", content: "You are a careful assistant." },
	{ role: "user", content: ask },
	{ role: "assistant", content: [firstCall] },
	{ role: "toolResult", toolName: firstCall.name, toolCallId: firstCall.id, content: fileText.slice(0, 4000) }
]);
const answer = (second.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("").trim();
check("round 2: answered without another call", second.stopReason !== "toolUse", `stopReason=${second.stopReason}`);
check("round 2: answer carries the package name", answer.includes(expected.name ?? "·"), JSON.stringify(answer.slice(0, 120)));
check("round 2: answer carries the version", answer.includes(expected.version ?? "·"), expected.version);

console.log("");
if (failures === 0) console.log("verify-toolbridge: ALL PASSED");
else {
	console.log(`verify-toolbridge: ${failures} FAILURE(S)`);
	process.exitCode = 1;
}
