/**
 * dsh-quick-connect usage plane.
 *
 * Reads Quick's own usage counters over the tenant DataPlane's qbs-event
 * channel:
 *
 *   POST {tenant}/integration/quick-work/qbs-event
 *   Authorization: Bearer <access token>
 *   {"eventType":"invokeAgent","eventBody":{"invokeAgent":{
 *       "path":"profile/usage","queryParams":{"_method":"GET"},"body":{}}}}
 *
 * The answer's `invokeAgentResponse` is either an object or a JSON *string*
 * of the inner `api_response`; `body` holds the usage JSON:
 *
 *   {session:{used,limit,label,percent,…}, monthly:{…},
 *    subscription:{subscription_type, free_trial_metadata}}
 *
 * Verified 2026-11-22 (QUICK_LITE_FREE_TRIAL): session limit 100, monthly
 * limit 600.
 *
 * @module lib/usage
 */
import { tunneledFetch } from "./creds.js";

export const USAGE_TIMEOUT_MS = 15_000;

/**
 * One invokeAgent qbs-event call. `path` must not start with a slash.
 * Returns the inner api_response `{status, headers, body, body_encoding}` or
 * throws with a readable message.
 *
 * `proxyUrl` (optional) routes through an HTTP CONNECT tunnel for tenants
 * whose host does not resolve in public DNS.
 */
export async function invokeAgentPath(options) {
	const { tenantUrl, token, path, method = "GET", body = {}, timeoutMs = USAGE_TIMEOUT_MS, proxyUrl } = options;
	const envelope = {
		eventType: "invokeAgent",
		eventBody: {
			invokeAgent: {
				path: path.replace(/^\/+/, ""),
				queryParams: { _method: method.toUpperCase() },
				body
			}
		}
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const url = `${tenantUrl.replace(/\/+$/, "")}/integration/quick-work/qbs-event`;
	const init = {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(envelope),
		signal: controller.signal
	};
	try {
		const response = proxyUrl ? await tunneledFetch(url, init, proxyUrl) : await fetch(url, init);
		const text = await response.text();
		if (!response.ok) {
			throw Object.assign(new Error(`qbs-event HTTP ${response.status}: ${text.slice(0, 160)}`), { status: response.status });
		}
		const outer = JSON.parse(text);
		let inner = outer?.eventResponse?.invokeAgentResponse;
		if (inner === undefined || inner === null) {
			throw Object.assign(new Error(outer?.errorMessage || "qbs-event: empty invokeAgentResponse"), { status: 502 });
		}
		if (typeof inner === "string") inner = JSON.parse(inner);
		return inner;
	} finally {
		clearTimeout(timer);
	}
}

function parseBody(apiResponse) {
	const body = apiResponse?.body;
	if (typeof body !== "string") return body ?? undefined;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

/**
 * Fetch the usage document. Throws on transport failure; returns undefined
 * when the runtime answers 404 (route not served on this tenant).
 */
export async function fetchUsage(options) {
	try {
		const inner = await invokeAgentPath({ ...options, path: "profile/usage", method: "GET" });
		if (inner.status === 404) return undefined;
		if (inner.status >= 400) throw new Error(`profile/usage HTTP ${inner.status}`);
		const parsed = parseBody(inner);
		return isUsageDocument(parsed) ? parsed : undefined;
	} catch (error) {
		if (error?.status === 404) return undefined;
		throw error;
	}
}

function isUsageDocument(value) {
	if (typeof value !== "object" || value === null) return false;
	return typeof value.session === "object" || typeof value.monthly === "object" || typeof value.subscription === "object";
}

/** Human-readable subscription line for the status card. */
export function describeSubscription(usage) {
	const type = usage?.subscription?.subscription_type;
	if (typeof type !== "string" || type.length === 0) return undefined;
	const trial = usage?.subscription?.free_trial_metadata;
	if (trial?.status === "ACTIVE" && typeof trial.expiry_date === "number") {
		return `${type}（免费试用，${new Date(trial.expiry_date * 1000).toISOString().slice(0, 10)} 到期）`;
	}
	return type;
}
