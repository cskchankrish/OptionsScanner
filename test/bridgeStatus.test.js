/**
 * GET /api/bridge-status: config check + signed FLOW_PING, rate guard, public vs authenticated
 * views, and no side effects. All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
]) delete process.env[k];

const {
  createBridgeStatusHandler, resetBridgeStatusMemoryForTesting, STATUS_LOCK_KEY, STATUS_CACHE_KEY,
} = await import("../api/bridge-status.js");

const WEBHOOK_SECRET = "status-test-webhook-secret";
const BRIDGE_SECRET = "status-test-hmac-key-XYZ";
const BRIDGE_URL = "https://algo.example.test:8443/flow-order?token=abc";
const ON = { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: BRIDGE_URL, FLOW_BRIDGE_SECRET: BRIDGE_SECRET, TV_WEBHOOK_SECRET: WEBHOOK_SECRET };
const T0 = Date.UTC(2026, 10, 11, 5, 30, 0);
process.env.TV_WEBHOOK_SECRET = WEBHOOK_SECRET;

const okReply = (extra = {}) => ({
  status: "ok", mode: "dry_run", flowBridgeEnabled: true,
  accounts: [{ account: "ZERODHA-1", position: 0 }],
  feed: { feed: "kite", quotes: 42, down: false },
  serverTime: T0 + 1500,
  ...extra,
});
const reply = (status, obj) => async () => new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status });

function fakeRedis() {
  const store = {};
  return {
    store,
    setNx: async (k, v) => { if (k in store) return false; store[k] = v; return true; },
    get: async (k) => store[k] ?? null,
    set: async (k, v) => { store[k] = v; return true; },
  };
}
const noRedis = {
  setNx: async () => { throw new Error("Redis not configured"); },
  get: async () => null,
  set: async () => false,
};

function setup({ env = ON, algo = reply(200, okReply()), redis = fakeRedis(), clock } = {}) {
  resetBridgeStatusMemoryForTesting();
  const calls = [];
  let now = T0;
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return algo(url, init); };
  const handler = createBridgeStatusHandler({
    now: clock || (() => now),
    env: () => env,
    fetchImpl,
    ...redis,
  });
  const run = async (query = {}, headers = {}) => {
    const req = { method: "GET", query, headers, body: undefined };
    const res = {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      setHeader() { return this; },
      json(d) { this.body = d; return this; },
      end() { return this; },
    };
    await handler(req, res);
    return res;
  };
  const authed = (query = {}) => run({ ...query, key: WEBHOOK_SECRET });
  return { run, authed, calls, redis, advance: (ms) => { now += ms; } };
}

/** Asserts no secret / full URL anywhere in a response or a captured log. */
function assertClean(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  for (const bad of [BRIDGE_SECRET, WEBHOOK_SECRET, BRIDGE_URL, "/flow-order", "token=abc"]) {
    assert.ok(!s.includes(bad), `leaked ${bad}`);
  }
}

// Capture all console output for the leak check.
const logs = [];
for (const m of ["log", "warn", "error", "info"]) {
  const orig = console[m];
  console[m] = (...a) => { logs.push(a.map(String).join(" ")); if (process.env.SHOW_LOGS) orig(...a); };
}

test("ping: signed FLOW_PING to <origin>/flow-ping, exact bytes, no FLOW_ENTRY", async () => {
  const s = setup();
  const res = await s.authed();
  assert.equal(res.body.state, "OK");
  assert.equal(s.calls.length, 1);
  const { url, init } = s.calls[0];
  assert.equal(url, "https://algo.example.test:8443/flow-ping", "path, query replaced");
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["v", "type", "ts"]);
  assert.equal(body.type, "FLOW_PING");
  assert.equal(body.ts, T0);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["X-Flow-Timestamp"], String(T0));
  assert.equal(init.headers["X-Flow-Signature"], createHmac("sha256", BRIDGE_SECRET).update(`${T0}.${init.body}`).digest("hex"));
});

test("OK: authenticated detail has config presence, target host, mode, accounts, feed, latency, clock diff, allow-list", async () => {
  const s = setup();
  const res = await s.authed();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.cached, false);
  const d = res.body.detail;
  assert.deepEqual(
    { enabledFlag: d.config.enabledFlag, urlPresent: d.config.urlPresent, urlValid: d.config.urlValid, secretPresent: d.config.secretPresent },
    { enabledFlag: true, urlPresent: true, urlValid: true, secretPresent: true },
  );
  assert.equal(d.config.target, "https://algo.example.test:8443");
  assert.deepEqual(d.config.decisions, ["EXECUTE_TIER1_SCOUT", "EXECUTE_HIGH_CONVICTION_SYNERGY"]);
  assert.equal(d.algo.mode, "dry_run");
  assert.deepEqual(d.algo.accounts, [{ account: "ZERODHA-1", position: 0 }]);
  assert.deepEqual(d.algo.feed, { feed: "kite", quotes: 42, down: false });
  assert.equal(d.ping.httpStatus, 200);
  assert.ok(Number.isFinite(d.ping.latencyMs));
  assert.ok(Math.abs(d.algo.clockDiffMs - 1500) < 100, `clock diff ${d.algo.clockDiffMs}`);
  assertClean(res.body);
});

test("public caller gets only { ok, state, checkedAt, cached }", async () => {
  const s = setup();
  const res = await s.run();
  assert.deepEqual(Object.keys(res.body).sort(), ["cached", "carryEnabled", "checkedAt", "ok", "state"]);
  assert.equal(res.body.state, "OK");
  assertClean(res.body);
});

test("wrong credential -> 401, no ping", async () => {
  const s = setup();
  const res = await s.run({ key: "nope" });
  assert.equal(res.statusCode, 401);
  assert.equal(s.calls.length, 0);
});

const stateCases = [
  ["OFF (flag unset)", { env: { ...ON, FLOW_BRIDGE_ENABLED: "" } }, "OFF", 0],
  ["OFF (flag false)", { env: { ...ON, FLOW_BRIDGE_ENABLED: "false" } }, "OFF", 0],
  ["MISCONFIGURED url missing", { env: { ...ON, FLOW_BRIDGE_URL: "" } }, "MISCONFIGURED", 0, /FLOW_BRIDGE_URL missing/],
  ["MISCONFIGURED url invalid", { env: { ...ON, FLOW_BRIDGE_URL: "not a url" } }, "MISCONFIGURED", 0, /not a valid/],
  ["MISCONFIGURED url ftp", { env: { ...ON, FLOW_BRIDGE_URL: "ftp://x.test/a" } }, "MISCONFIGURED", 0, /not a valid/],
  ["MISCONFIGURED secret missing", { env: { ...ON, FLOW_BRIDGE_SECRET: "" } }, "MISCONFIGURED", 0, /FLOW_BRIDGE_SECRET missing/],
  ["UNREACHABLE network", { algo: async () => { const e = new Error(`connect ECONNREFUSED ${BRIDGE_URL} ${BRIDGE_SECRET}`); e.code = "ECONNREFUSED"; throw e; } }, "UNREACHABLE", 1, /ECONNREFUSED/],
  ["UNREACHABLE timeout", { algo: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) }, "UNREACHABLE", 1, /timeout after 4000ms/],
  ["UNREACHABLE 500", { algo: reply(500, "boom") }, "UNREACHABLE", 1, /unexpected HTTP 500/],
  ["ALGO_OUTDATED 404", { algo: reply(404, "Not Found") }, "ALGO_OUTDATED", 1],
  ["SIGNATURE_REJECTED 401", { algo: reply(401, { error: "bad signature" }) }, "SIGNATURE_REJECTED", 1],
  ["ALGO_REJECTED clock skew", { algo: reply(200, { status: "rejected", reason: "clock skew 45s" }) }, "ALGO_REJECTED", 1, /clock skew 45s/],
  ["ALGO_BRIDGE_OFF", { algo: reply(200, okReply({ flowBridgeEnabled: false })) }, "ALGO_BRIDGE_OFF", 1],
  ["OK", {}, "OK", 1],
];
for (const [name, opts, state, pings, detailRe] of stateCases) {
  test(`state ${name}`, async () => {
    const s = setup(opts);
    const res = await s.authed();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.state, state);
    assert.equal(res.body.ok, state === "OK");
    assert.equal(s.calls.length, pings);
    if (detailRe) assert.match(JSON.stringify(res.body.detail), detailRe);
    assertClean(res.body);
    const pub = await setup(opts).run();
    assert.equal(pub.body.state, state);
    assert.deepEqual(Object.keys(pub.body).sort(), ["cached", "carryEnabled", "checkedAt", "ok", "state"]);
  });
}

test("cache window: one real ping per 60s, cached:true inside it, new ping after it", async () => {
  const s = setup();
  const r1 = await s.run();
  assert.equal(r1.body.cached, false);
  s.advance(30_000);
  const r2 = await s.run();
  const r3 = await s.authed();
  assert.equal(r2.body.cached, true);
  assert.equal(r3.body.cached, true);
  assert.equal(r3.body.state, "OK");
  assert.equal(r3.body.detail.algo.mode, "dry_run", "authenticated caller sees cached detail");
  assert.equal(r2.body.checkedAt, r1.body.checkedAt);
  assert.equal(s.calls.length, 1);
  // The Redis lock key expires after 60s; emulate the expiry.
  s.advance(31_000);
  delete s.redis.store[STATUS_LOCK_KEY];
  const r4 = await s.run();
  assert.equal(r4.body.cached, false);
  assert.equal(s.calls.length, 2);
  assertClean(s.redis.store);
});

test("concurrent public callers: exactly one ping (atomic SET NX)", async () => {
  const s = setup();
  await Promise.all([s.run(), s.run(), s.run(), s.run()]);
  assert.equal(s.calls.length, 1);
});

test("fresh=1 bypasses the cache only when authenticated", async () => {
  const s = setup();
  await s.run();
  const pub = await s.run({ fresh: "1" });
  assert.equal(pub.body.cached, true, "public fresh=1 ignored");
  assert.equal(s.calls.length, 1);
  const auth = await s.authed({ fresh: "1" });
  assert.equal(auth.body.cached, false);
  assert.equal(s.calls.length, 2);
});

test("without Redis: in-memory guard still limits to one ping per 60s", async () => {
  const s = setup({ redis: noRedis });
  assert.equal((await s.run()).body.cached, false);
  s.advance(10_000);
  const r2 = await s.authed();
  assert.equal(r2.body.cached, true);
  assert.equal(r2.body.detail.algo.mode, "dry_run");
  assert.equal(s.calls.length, 1);
  s.advance(60_000);
  assert.equal((await s.run()).body.cached, false);
  assert.equal(s.calls.length, 2);
});

test("no side effects: only the status keys are written, only /flow-ping is called, no Telegram", async () => {
  const s = setup();
  const prevFetch = globalThis.fetch;
  const stray = [];
  globalThis.fetch = async (u) => { stray.push(String(u)); return new Response("{}"); };
  try {
    await s.authed({ fresh: "1" });
    await s.run();
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert.deepEqual(Object.keys(s.redis.store).sort(), [STATUS_CACHE_KEY, STATUS_LOCK_KEY].sort());
  assert.ok(!("nifty:tv:active_trade" in s.redis.store));
  assert.deepEqual(stray, [], "no other network call (Telegram, Redis REST, FLOW_ENTRY)");
  for (const c of s.calls) {
    assert.ok(c.url.endsWith("/flow-ping"));
    assert.equal(JSON.parse(c.init.body).type, "FLOW_PING");
  }
});

test("POST is refused", async () => {
  const s = setup();
  const req = { method: "POST", query: {}, headers: {} };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
  await createBridgeStatusHandler({ env: () => ON, fetchImpl: async () => { throw new Error("no"); }, ...fakeRedis() })(req, res);
  assert.equal(res.statusCode, 405);
  assert.equal(s.calls.length, 0);
});

test("no secret or full URL in any log line", () => {
  assertClean(logs.join("\n"));
});
