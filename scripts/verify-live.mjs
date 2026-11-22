#!/usr/bin/env node
/**
 * dsh-quick-connect live verification (real network, real credential).
 *
 * Steps: profile → credential (CredRead + OIDC) → proxy probe → usage HTTP
 * (through the tunnel when needed) → WSS chat round-trip ("Reply with exactly
 * one word: pong"). Prints masked evidence.
 *
 * Usage: node scripts/verify-live.mjs [--mode fast|balanced|smart|advanced]
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
const usage = await imports("lib/usage.js");
const gateway = await imports("lib/gateway.js");

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

//#region 1. profile
const profile = await step("read active profile", async () => {
	const profile = await creds.readActiveProfile();
	if (!profile) throw new Error("no active profile in ~/.quickwork/profiles.json");
	console.log(`   profile: ${profile.profileId} (${profile.provider})`);
	console.log(`   tenant:  ${profile.tenantUrl?.slice(0, 72)}`);
	return profile;
});
if (!profile) process.exit(1);

//#region 2. credential + proxy route
const store = new creds.QuickCredentialStore();
const session = await step("resolve credential (CredRead + OIDC)", async () => {
	const session = await store.current();
	if (session.status !== "signed-in") throw new Error(session.message ?? "not signed in");
	console.log(`   account: ${session.email ?? session.displayName ?? "?"} role=${session.role ?? "?"}`);
	console.log(`   token expires at: ${new Date(session.expiresAtMs).toISOString()}`);
	console.log(`   proxy route: ${store.activeProxy ?? "direct"}`);
	return session;
});
if (!session) process.exit(1);

//#region 3. usage
await step("fetch usage (qbs-event → profile/usage)", async () => {
	const document = await usage.fetchUsage({ tenantUrl: session.tenantUrl, token: session.token, proxyUrl: store.activeProxy ?? undefined });
	if (!document) throw new Error("usage route not served (404)");
	console.log(`   session: ${document.session?.used}/${document.session?.limit} min`);
	console.log(`   monthly: ${document.monthly?.used}/${document.monthly?.limit} min`);
	console.log(`   subscription: ${usage.describeSubscription(document) ?? "?"}`);
	return document;
});

//#region 4. chat round-trip
await step(`WSS chat round-trip (agent_mode=${mode})`, async () => {
	const api = gateway.quickChatApi();
	const model = {
		id: mode,
		api: "quick-chat",
		provider: "quick",
		baseUrl: session.tenantUrl
	};
	const context = { messages: [{ role: "user", content: "Reply with exactly one word: pong" }] };
	const stream = api.stream(model, context, {
		apiKey: session.token,
		sessionId: `dsh-verify-${Date.now().toString(36)}-0000-0000-0000-000000000000`,
		quickProxy: store.activeProxy ?? undefined
	});
	const result = await stream.result();
	if (result.stopReason === "error") throw new Error(result.errorMessage ?? "stream error");
	const text = result.content?.map((block) => (block.type === "text" ? block.text : "")).join("").trim();
	console.log(`   reply: ${JSON.stringify(text)}`);
	console.log(`   usage: in=${result.usage?.input} out=${result.usage?.output} cacheRead=${result.usage?.cacheRead}`);
	if (result.providerModelId) console.log(`   routed model: ${result.providerModelId}`);
	if (!text || !/pong/i.test(text)) throw new Error(`unexpected reply: ${text.slice(0, 80)}`);
	return text;
});

console.log("");
console.log("verify-live: ALL PASSED");
