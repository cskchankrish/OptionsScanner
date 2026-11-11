/**
 * Shared fail-closed authorisation for state-changing / message-sending API calls.
 *
 * The secret comes from `process.env.TV_WEBHOOK_SECRET` and is read on every call
 * (so tests and redeploys pick up changes). If it is unset or left at the
 * placeholder "CHANGE_ME", every protected call is refused with 503.
 *
 * Accepted credential locations:
 *   - `x-webhook-secret` request header
 *   - `key` query parameter
 *   - `secret` field in the JSON body (TradingView alerts carry it here)
 *
 * The secret is never logged and never echoed in a response.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function getConfiguredWebhookSecret() {
  const s = process.env.TV_WEBHOOK_SECRET;
  if (typeof s !== "string" || s.length === 0 || s === "CHANGE_ME") return null;
  return s;
}

/** Constant-time comparison (hashes both sides so lengths always match). */
export function secretsMatch(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export function extractRequestSecret(req, body = null) {
  const header = readHeader(req?.headers, "x-webhook-secret");
  if (typeof header === "string" && header.length > 0) return header;
  const key = req?.query?.key;
  if (typeof key === "string" && key.length > 0) return key;
  if (Array.isArray(key) && typeof key[0] === "string") return key[0];
  const bodySecret = body?.secret;
  if (typeof bodySecret === "string" && bodySecret.length > 0) return bodySecret;
  return null;
}

/**
 * @returns {{ ok: true } | { ok: false, status: 503 | 401, error: string }}
 */
export function authorizeRequest(req, body = null) {
  const expected = getConfiguredWebhookSecret();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "Webhook secret not configured on server (TV_WEBHOOK_SECRET). Request refused.",
    };
  }
  const provided = extractRequestSecret(req, body);
  if (!secretsMatch(provided, expected)) {
    return { ok: false, status: 401, error: "Unauthorized: missing or invalid webhook secret" };
  }
  return { ok: true };
}
