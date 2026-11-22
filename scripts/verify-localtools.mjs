#!/usr/bin/env node
/**
 * Local-tools verification (real network, real credential, real device agent).
 *
 * Walks the same path the host takes — runtime sweep → device agent boot →
 * model descriptor (quickDevice) → chat stream — and asks for work that can
 * only be done by this machine. Passes when the model's answer contains the
 * locally computed value.
 *
 * Usage: node scripts/verify-localtools.mjs [--mode=fast]
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const imports = (spec) => import(pathToFileURL(join(here, "..", spec)).href);

const index = await imports("lib/index.js");
const gateway = await imports("lib/gateway.js");

const mode = (() => {
	const flag = process.argv.find((arg) => arg.startsWith("--mode="));
	const value = flag?.split("=")[1];
	return ["fast", "balanced", "smart", "advanced"].includes(value) ? value : "fast";
})();

const workDir = process.env.QW_VERIFY_DIR ?? join(here, "..", ".verify");
const stamp = Date.now().toString(36);
const probeFile = join(workDir, `local-tools-${stamp}.txt`).replace(/\\/g, "/");

// QW_VERIFY_DEFAULT_FOLDERS=1 exercises the default allow-list (host cwd +
// the workspaces DSH keeps under ~/.dsh/sessions) instead of one explicit dir.
const useDefaultFolders = process.env.QW_VERIFY_DEFAULT_FOLDERS === "1";
const config = {
	localTools: true,
	...(useDefaultFolders ? {} : { allowedFolders: workDir.replace(/\\/g, "/") })
};

const step = async (label, fn) => {
	process.stdout.write(`→ ${label} … `);
	try {
		const result = await fn();
		console.log("OK");
		return result;
	} catch (error) {
		console.log("FAIL");
		console.error("  ", error instanceof Error ? error.message : error);
		process.exitCode = 1;
		return undefined;
	}
};

const runtime = index.createRuntime(config, () => config);

const session = await step("credential + tenant", async () => {
	await index.sweep(runtime, { usage: false });
	if (runtime.status?.status !== "signed-in") throw new Error(runtime.status?.message ?? "not signed in");
	console.log(`   account: ${runtime.status.email ?? "?"} tenant: ${String(runtime.tenantUrl).slice(0, 60)}`);
	return runtime.status;
});
if (!session) process.exit(1);

const outpost = await step("boot device agent (outpost)", async () => {
	const outpost = await index.ensureOutpost(runtime);
	if (!outpost?.ready) throw new Error(outpost?.error ?? "outpost not ready");
	console.log(`   id: ${outpost.outpostId} name: ${outpost.outpostName} tools: ${outpost.info.toolCount} groups: ${outpost.info.groups.join(",")}`);
	console.log(`   allowed folders: ${[...outpost.allowedFolders].join(" | ") || "(none)"}`);
	return outpost;
});
if (!outpost) process.exit(1);

const adapter = index.createQuickAdapter({
	catalog: runtime.catalog,
	store: runtime.store,
	runtime,
	config: () => config
});
const model = adapter.models().find((candidate) => candidate.id === mode);
if (!model) {
	console.error(`no model ${mode}`);
	process.exit(1);
}

const ask = async (prompt) => {
	const api = gateway.quickChatApi();
	const stream = api.stream(model, { messages: [{ role: "user", content: prompt }] }, {
		apiKey: session.token,
		sessionId: `dsh-local-${Date.now().toString(36)}-0000-0000-0000-000000000000`,
		quickProxy: runtime.store.activeProxy ?? undefined
	});
	const result = await stream.result();
	if (result.stopReason === "error") throw new Error(result.errorMessage ?? "stream error");
	return (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
};

await step("local python execution", async () => {
	const baseline = outpost.invocations;
	const text = await ask("只用你本机的 Python 工具计算 7 的 21 次方，把结果原样告诉我。不要心算，也不要使用云端沙箱。");
	const expected = (7n ** 21n).toString();
	console.log(`   reply: ${JSON.stringify(text.slice(0, 200))}`);
	console.log(`   device invocations: ${outpost.invocations - baseline}`);
	if (!text.includes(expected)) throw new Error(`expected ${expected} in reply`);
	if (outpost.invocations === baseline) throw new Error("no device invocation was relayed");
	return text;
});

await step("local file write + read back", async () => {
	if (existsSync(probeFile)) rmSync(probeFile);
	const baseline = outpost.invocations;
	const text = await ask(
		`用本机文件工具完成两件事：1) 把字符串 ok-${stamp} 写入 ${probeFile}；2) 再读回这个文件确认内容。全部用本机工具。最后把读到的内容原样告诉我。`
	);
	console.log(`   reply: ${JSON.stringify(text.slice(0, 200))}`);
	console.log(`   device invocations: ${outpost.invocations - baseline}`);
	if (!existsSync(probeFile)) throw new Error(`file was not written: ${probeFile}`);
	const onDisk = (await import("node:fs")).readFileSync(probeFile, "utf8").trim();
	console.log(`   on disk: ${JSON.stringify(onDisk)}`);
	if (!onDisk.includes(`ok-${stamp}`)) throw new Error("file content mismatch");
	if (!text.includes(`ok-${stamp}`)) throw new Error("reply does not echo the content");
	return onDisk;
});

outpost.stop();
console.log("");
if (process.exitCode) {
	console.log("verify-localtools: FAILED");
} else {
	console.log("verify-localtools: ALL PASSED");
}
process.exit(process.exitCode ?? 0);
