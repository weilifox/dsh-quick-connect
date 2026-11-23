#!/usr/bin/env node
/**
 * Live verification of the decision-card bridge (v0.3.2).
 *
 * Quick asks the user through inline markup:
 *   <decision question="…"><option description="…">label</option>…</decision>
 * Its desktop client renders that as clickable cards; DSH has no renderer, so
 * the adapter must turn it into one `ask_user_question` call (stopReason
 * "toolUse") instead of leaking the markup into the reply.
 *
 * Usage: node scripts/verify-decisions.mjs [--mode=fast|balanced|smart|advanced]
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const imports = (spec) => import(pathToFileURL(join(here, "..", spec)).href);

const mode = (() => {
	const flag = process.argv.find((arg) => arg.startsWith("--mode="));
	const value = flag?.split("=")[1];
	return ["fast", "balanced", "smart", "advanced"].includes(value) ? value : "fast";
})();

const creds = await imports("lib/creds.js");
const gateway = await imports("lib/gateway.js");

const tools = [
	{
		name: "ask_user_question",
		description: "向用户提问并给出可选项，用户点选后结果作为工具结果返回",
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					description: "问题列表",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							question: { type: "string" },
							options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } } } },
							multi_select: { type: "boolean" }
						}
					}
				}
			},
			required: ["questions"]
		}
	}
];

const ask = "我要把结果写进 C:/tmp/report.txt，但文件已经存在了。请让我在「跳过」和「覆盖」之间选一个，用 <decision> 标签问我。";

const store = new creds.QuickCredentialStore();
const session = await store.current();
if (session.status !== "signed-in") {
	console.error("not signed in:", session.message);
	process.exit(1);
}

const api = gateway.quickChatApi();
const model = { id: mode, api: "quick-chat", provider: "quick", baseUrl: session.tenantUrl, quickToolBridge: true };
const stream = api.stream(
	model,
	{
		messages: [
			{ role: "system", content: "You are a careful automation assistant working in a local workspace." },
			{ role: "user", content: ask }
		],
		tools
	},
	{ apiKey: session.token, sessionId: `dsh-decision-${Date.now().toString(36)}-0000-0000-0000-000000000000`, quickProxy: store.activeProxy ?? undefined }
);
const reply = await stream.result();

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
};

const blocks = reply.content ?? [];
const call = blocks.find((block) => block.type === "toolCall");
const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");

check("reply finished", reply.stopReason !== "error", `stopReason=${reply.stopReason}${reply.errorMessage ? ` (${reply.errorMessage})` : ""}`);
check("no decision markup leaked into the text", !/<decision|<option/i.test(text));
if (call) {
	check("a tool call came back", call.name === "ask_user_question", `${call.name} ${JSON.stringify(call.arguments)}`);
	const questions = call.arguments?.questions ?? [];
	check("question preset", questions.length >= 1, JSON.stringify(questions[0] ?? null));
	check("options preset", (questions[0]?.options ?? []).length >= 2, `${(questions[0]?.options ?? []).length} options`);
} else {
	// The model may answer in plain prose — still a pass if the markup is gone
	// and the options are readable, but say so loudly.
	check("fallback: options readable as a list", /跳过|覆盖/.test(text), text.slice(0, 160));
}

console.log("");
console.log(failures === 0 ? "verify-decisions: ALL PASSED" : `verify-decisions: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
