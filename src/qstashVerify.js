/**
 * Dependency-free Upstash QStash request-signature verification.
 *
 * QStash signs each delivery with an HS256 JWT in the `Upstash-Signature` header, using the
 * project's current signing key (and, during key rotation, the next one). Claims checked here,
 * mirroring @upstash/qstash's Receiver:
 *   - signature: HMAC-SHA256(`${header}.${payload}`, signingKey) — tried with the current key, then the next
 *   - iss === "Upstash"
 *   - exp / nbf within a small clock tolerance
 *   - body === base64url(sha256(raw request body)) (padding-insensitive)
 * Additionally, if `expectedPath` is given, the `sub` URL's pathname must equal it, so a signature
 * minted for another QStash destination on the same account cannot be replayed here.
 *
 * Keys come from QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY. Keys are never logged.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CLOCK_TOLERANCE_SEC = 30;

function b64urlToBuffer(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function stripPad(s) {
  return String(s).replace(/=+$/, "");
}

export function getQstashSigningKeys(env = process.env) {
  return [env.QSTASH_CURRENT_SIGNING_KEY, env.QSTASH_NEXT_SIGNING_KEY].filter(
    (k) => typeof k === "string" && k.length > 0
  );
}

/**
 * @param {object} args
 * @param {string} args.signature value of the Upstash-Signature header
 * @param {string|Buffer} args.body raw request body ("" when empty)
 * @param {string[]} [args.keys] signing keys to try (defaults to env)
 * @param {number} [args.nowSec]
 * @param {string|null} [args.expectedPath] e.g. "/api/poll"
 * @returns {{ ok: true, claims: object } | { ok: false, error: string }}
 */
export function verifyQstashSignature({
  signature,
  body,
  keys = getQstashSigningKeys(),
  nowSec = Math.floor(Date.now() / 1000),
  expectedPath = null,
}) {
  if (!keys.length) return { ok: false, error: "QStash signing keys not configured" };
  if (typeof signature !== "string" || signature.length === 0) return { ok: false, error: "missing Upstash-Signature" };
  const parts = signature.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed signature" };
  const [h, p, sig] = parts;

  let header;
  let claims;
  try {
    header = JSON.parse(b64urlToBuffer(h).toString("utf8"));
    claims = JSON.parse(b64urlToBuffer(p).toString("utf8"));
  } catch (e) {
    return { ok: false, error: "malformed signature" };
  }
  if (header?.alg !== "HS256") return { ok: false, error: "unsupported signature algorithm" };

  const provided = b64urlToBuffer(sig);
  const signatureValid = keys.some((key) => {
    const expected = createHmac("sha256", key).update(`${h}.${p}`).digest();
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  });
  if (!signatureValid) return { ok: false, error: "invalid signature" };

  if (claims.iss !== "Upstash") return { ok: false, error: "invalid issuer" };
  if (Number.isFinite(claims.exp) && nowSec > claims.exp + CLOCK_TOLERANCE_SEC) return { ok: false, error: "signature expired" };
  if (!Number.isFinite(claims.exp)) return { ok: false, error: "signature has no expiry" };
  if (Number.isFinite(claims.nbf) && nowSec + CLOCK_TOLERANCE_SEC < claims.nbf) return { ok: false, error: "signature not yet valid" };

  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : "", "utf8");
  const bodyHash = createHash("sha256").update(raw).digest("base64url");
  if (stripPad(claims.body || "") !== stripPad(bodyHash)) return { ok: false, error: "body hash mismatch" };

  if (expectedPath) {
    let path = null;
    try {
      path = new URL(String(claims.sub)).pathname.replace(/\/+$/, "");
    } catch (e) {
      path = null;
    }
    if (path !== expectedPath.replace(/\/+$/, "")) return { ok: false, error: "signature destination mismatch" };
  }
  return { ok: true, claims };
}

/** Test helper / reference signer (same format QStash produces). */
export function signQstashForTesting({ key, body = "", url, nowSec = Math.floor(Date.now() / 1000), ttlSec = 300, iss = "Upstash" }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc({
    iss,
    sub: url,
    exp: nowSec + ttlSec,
    nbf: nowSec,
    iat: nowSec,
    jti: `jwt_${nowSec}`,
    body: createHash("sha256").update(body).digest("base64url"),
  });
  const s = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
