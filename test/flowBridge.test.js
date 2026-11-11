/**
 * Flow execution bridge (scanner side): dispatcher, atomic single-position lock, trade identity,
 * exit matching and the Algo sync-back. All I/O is injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_MAX_AGE_SEC", "FLOW_REFRESH_TIMEOUT_MS",
  "FLOW_BRIDGE_ENABLED", "FLOW_BRIDGE_URL", "FLOW_BRIDGE_SECRET", "FLOW_BRIDGE_DECISIONS", "FLOW_BRIDGE_TIMEOUT_MS",
]) delete process.env[k];

const webhook = await import("../api/tv-webhook.js");
const bridge = await import("../src/flowBridge.js");

const SECRET = "bridge-test-webhook-secret";
const BRIDGE_SECRET = "bridge-test-hmac-key";
const BRIDGE_URL = "https://algo.example.test/flow";
const KEY = "nifty:tv:active_trade";
const BRIDGE_ON = { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: BRIDGE_URL, FLOW_BRIDGE_SECRET: BRIDGE_SECRET };

const tick = () => new Promise((r) => setImmediate(r));

/** Fake Upstash client with real SET NX semantics; yields between calls so requests interleave. */
function createFakeRedis(initial = {}) {
  const store = { ...initial };
  const ttl = {};
  const lists = {};
  return {
    store,
    ttl,
    lists,
    async get(k) { await tick(); return store[k] ?? null; },
    async set(k, v, opts = {}) {
      await tick();
      if (opts.nx && k in store) return null;
      store[k] = v;
      ttl[k] = opts.ex ?? null;
      return "OK";
    },
    async del(k) { await tick(); if (k in store) { delete store[k]; delete ttl[k]; return 1; } return 0; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim() { return "OK"; },
    async lrange(k) { return lists[k] || []; },
  };
}

function mockReqRes({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  const req = { method, body: typeof body === "string" ? body : JSON.stringify(body), query, headers };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader() { return this; },
    json(d) { this.body = d; return this; },
    send(d) { this.body = d; return this; },
    end() { return this; },
  };
  return { req, res };
}

const bearAlert = (extra = {}) => ({
  secret: SECRET,
  sym: "NSE:NIFTY",
  tf: "15",
  dir: "SHORT",
  grade: "SYNERGY_BEAR",
  close: 24960,
  sl: 25025,
  cappedSl: 25025,
  rDist: 65,
  t1Dist: 65,
  t2Dist: 130,
  ...extra,
});

// ΔPCR 0.6 => EXECUTE_HIGH_CONVICTION_SYNERGY with recommendedLots 2.
const snapshot = (overrides = {}) => ({
  snapshotAt: Date.now() - 20_000,
  snapshotSource: "poller",
  corridor: { deltaPCR: 0.6, floorStrike: 24700, roofStrike: 25200 },
  futures: { quadrant: "SHORT_BUILDUP" },
  smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" },
  ...overrides,
});

const json200 = (obj) => async () => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
const ACCEPT = json200({ status: "accepted", reason: null, mode: "dry_run", orderRef: "ORD-1" });

/**
 * Runs a case with secret + fake Redis + injected deps. `algo(url, init, n)` answers dispatches.
 */
function bridgeCase({ env = {}, initial = {}, algo = ACCEPT, snap = snapshot() } = {}, fn) {
  return async () => {
    const prev = { TV_WEBHOOK_SECRET: process.env.TV_WEBHOOK_SECRET };
    process.env.TV_WEBHOOK_SECRET = SECRET;
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    const redis = createFakeRedis({ "nifty:flow:latest": JSON.stringify(snap), ...initial });
    const sent = [];
    const calls = [];
    let n = 0;
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({
      now: () => Date.now(),
      isLiveMarket: async () => false,
      refresh: async () => ({ ok: false, stage: "nse", error: "no refresh in tests" }),
      sendText: async (t) => { sent.push(t); return true; },
      bridgeFetch: async (url, init) => { calls.push({ url, init }); return algo(url, init, ++n); },
      newTradeId: () => `ft-test-${++idSeq}`,
    });
    try {
      await fn({ redis, sent, calls });
    } finally {
      webhook.setRedisClientForTesting(null);
      webhook.setWebhookDepsForTesting(null);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}
let idSeq = 0;

async function post(body) {
  const { req, res } = mockReqRes({ body });
  await webhook.default(req, res);
  return res;
}
async function get(query) {
  const { req, res } = mockReqRes({ method: "GET", query: { key: SECRET, ...query } });
  await webhook.default(req, res);
  return res;
}
const stored = (redis) => (redis.store[KEY] ? JSON.parse(redis.store[KEY]) : null);

// ── Config / pure helpers ──

test("config: bridge is enabled only with the flag AND url AND secret", () => {
  assert.equal(bridge.getFlowBridgeConfig({}).enabled, false);
  assert.equal(bridge.getFlowBridgeConfig({ ...BRIDGE_ON, FLOW_BRIDGE_ENABLED: "false" }).enabled, false);
  assert.equal(bridge.getFlowBridgeConfig({ ...BRIDGE_ON, FLOW_BRIDGE_URL: "" }).enabled, false);
  assert.equal(bridge.getFlowBridgeConfig({ ...BRIDGE_ON, FLOW_BRIDGE_SECRET: "" }).enabled, false);
  const c = bridge.getFlowBridgeConfig(BRIDGE_ON);
  assert.equal(c.enabled, true);
  assert.deepEqual(c.decisions, ["EXECUTE_TIER1_SCOUT", "EXECUTE_HIGH_CONVICTION_SYNERGY"]);
  assert.equal(c.timeoutMs, 3000);
  assert.equal(bridge.getFlowBridgeConfig({ ...BRIDGE_ON, FLOW_BRIDGE_TIMEOUT_MS: "99999" }).timeoutMs, 5000);
  assert.equal(bridge.getFlowBridgeConfig({ ...BRIDGE_ON, FLOW_BRIDGE_TIMEOUT_MS: "10" }).timeoutMs, 1000);
});

test("budget: dispatch timeout shrinks with elapsed time and is skipped when the budget is gone", () => {
  assert.equal(bridge.computeDispatchTimeoutMs(3000, 500), 3000);
  // After a full 8s refresh plus ~1s: 15000 - 4000 - 9000 = 2000ms left.
  assert.equal(bridge.computeDispatchTimeoutMs(3000, 9000), 2000);
  assert.equal(bridge.computeDispatchTimeoutMs(3000, 10500), 0, "under 1s left => do not dispatch");
});

// ── Disabled bridge = today's behaviour ──

for (const env of [{}, { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: BRIDGE_URL }, { ...BRIDGE_ON, FLOW_BRIDGE_ENABLED: "false" }]) {
  test(`disabled bridge ${JSON.stringify(Object.keys(env))}: no dispatch, paper trade opened with an id, auto-lifecycle still manages it`, bridgeCase({ env }, async ({ redis, calls, sent }) => {
    const res = await post(bearAlert());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
    assert.equal(calls.length, 0, "never dispatched");
    assert.equal(sent.length, 0, "no bridge Telegram");
    const t = stored(redis);
    assert.ok(t.active);
    assert.match(t.id, /^ft-test-\d+$/);
    assert.equal(t.execution, undefined, "paper trade has no execution state");
    assert.equal(res.body.fusedVerdict.tradeId, t.id);
    assert.equal(res.body.fusedVerdict.execution, undefined);
    assert.equal(redis.ttl[KEY], 604800, "synergy trades keep the 7-day TTL");
    // Paper trade: SL hit closes it automatically, as today.
    const r = await webhook.evaluateActiveTradeLifecycle(25030, 25030, 25030, redis);
    assert.equal(r.event, "STOP_LOSS_HIT");
    assert.equal(stored(redis), null);
  }));
}

test("default id generator yields unique ids", () => {
  const a = bridge.newTradeId(1), b = bridge.newTradeId(1);
  assert.notEqual(a, b);
  assert.match(a, /^ft-1-[0-9a-f]{8}$/);
});

// ── Dispatch: body, lots, signature ──

test("dispatch: exact contract body, lots always 1, HMAC over the exact bytes sent", bridgeCase({ env: BRIDGE_ON }, async ({ redis, calls }) => {
  const res = await post(bearAlert());
  assert.equal(res.body.recommendedLots, 2, "scanner recommends 2 lots...");
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, BRIDGE_URL);
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["v", "type", "id", "ts", "grade", "decision", "dir", "spot", "entry", "sl", "t1", "t2", "lots", "snapshotAgeSec"]);
  assert.equal(body.lots, 1, "...but the Algo is always sent 1 lot");
  assert.equal(body.v, 1);
  assert.equal(body.type, "FLOW_ENTRY");
  assert.equal(body.id, stored(redis).id);
  assert.equal(body.grade, "SYNERGY_BEAR");
  assert.equal(body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(body.dir, "SHORT");
  assert.equal(body.spot, 24960);
  assert.equal(body.entry, 24960);
  assert.equal(body.sl, 25025);
  assert.equal(body.t1, 24895);
  assert.equal(body.t2, 24830);
  assert.ok(Number.isInteger(body.snapshotAgeSec));
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["X-Flow-Timestamp"], String(body.ts));
  const expected = createHmac("sha256", BRIDGE_SECRET).update(`${body.ts}.${init.body}`).digest("hex");
  assert.equal(init.headers["X-Flow-Signature"], expected);
  assert.match(init.headers["X-Flow-Signature"], /^[0-9a-f]{64}$/);
}));

test("allow-list: EXECUTE_MODERATE_SYNERGY is paper-only by default", bridgeCase({
  env: BRIDGE_ON,
  snap: snapshot({ corridor: { deltaPCR: 0.9, floorStrike: 24700, roofStrike: 25200 } }),
}, async ({ redis, calls }) => {
  const res = await post(bearAlert());
  assert.equal(res.body.decision, "EXECUTE_MODERATE_SYNERGY");
  assert.equal(calls.length, 0);
  assert.equal(stored(redis).execution, undefined, "paper trade, auto-managed");
}));

test("allow-list: FLOW_BRIDGE_DECISIONS can add EXECUTE_MODERATE_SYNERGY", bridgeCase({
  env: { ...BRIDGE_ON, FLOW_BRIDGE_DECISIONS: "EXECUTE_MODERATE_SYNERGY" },
  snap: snapshot({ corridor: { deltaPCR: 0.9, floorStrike: 24700, roofStrike: 25200 } }),
}, async ({ calls }) => {
  await post(bearAlert());
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).lots, 1);
}));

test("non-actionable grades never dispatch", bridgeCase({ env: BRIDGE_ON }, async ({ calls, redis }) => {
  const res = await post(bearAlert({ grade: "MEGA" }));
  assert.equal(res.body.decision, "LOG_ONLY");
  assert.equal(calls.length, 0);
  assert.equal(stored(redis), null);
}));

// ── Outcomes ──

test("accepted: execution ACCEPTED stored on the trade, lock held with TTL, Telegram says so", bridgeCase({ env: BRIDGE_ON }, async ({ redis, sent }) => {
  const res = await post(bearAlert());
  const t = stored(redis);
  assert.equal(t.execution.status, "ACCEPTED");
  assert.equal(t.execution.mode, "dry_run");
  assert.equal(t.execution.orderRef, "ORD-1");
  assert.ok(t.execution.at);
  assert.equal(redis.ttl[KEY], 604800, "synergy trades keep the 7-day TTL");
  assert.equal(res.body.fusedVerdict.execution.status, "ACCEPTED");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /SENT TO ALGO · AWAITING FILL/);
  assert.doesNotMatch(sent[0], /EXECUTED/);
  assert.ok(sent[0].includes(t.id));
}));

for (const status of ["rejected", "duplicate"]) {
  test(`${status}: NOT_EXECUTED, lock released, Telegram 'approved but NOT executed', next signal can open`, bridgeCase({
    env: BRIDGE_ON,
    algo: async (u, i, n) => n === 1
      ? new Response(JSON.stringify({ status, reason: "risk_*limit*", mode: "live", orderRef: null }), { status: 200 })
      : ACCEPT(),
  }, async ({ redis, sent, calls }) => {
    const res = await post(bearAlert());
    assert.equal(res.body.fusedVerdict.execution.status, "NOT_EXECUTED");
    assert.equal(res.body.fusedVerdict.execution.outcome, status.toUpperCase());
    assert.equal(res.body.fusedVerdict.execution.reason, "risk_*limit*");
    assert.equal(stored(redis), null, "position released");
    assert.match(sent[0], /APPROVED BUT NOT EXECUTED/);
    assert.match(sent[0], /risk\s?limit/, "reason shown (markdown stripped)");
    const res2 = await post(bearAlert());
    assert.equal(res2.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY", "not blocked");
    assert.equal(calls.length, 2);
    assert.equal(stored(redis).execution.status, "ACCEPTED");
  }));
}

const unknownCases = [
  ["HTTP 500", async () => new Response("boom", { status: 500 }), /HTTP 500/],
  ["network error", async () => { throw new Error("ECONNREFUSED"); }, /network error: ECONNREFUSED/],
  ["non-JSON 200", async () => new Response("<html>", { status: 200 }), /not JSON/],
  ["unrecognised status", json200({ status: "maybe" }), /unrecognised status/],
  ["timeout", (u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))), /timeout after 1000ms/],
];
for (const [name, algo, errRe] of unknownCases) {
  test(`unknown outcome (${name}): UNKNOWN, lock kept WITHOUT expiry, loud Telegram, next signal blocked`, bridgeCase({
    env: { ...BRIDGE_ON, FLOW_BRIDGE_TIMEOUT_MS: "1000" },
    algo,
  }, async ({ redis, sent, calls }) => {
    const res = await post(bearAlert());
    const t = stored(redis);
    assert.equal(t.execution.status, "UNKNOWN");
    assert.match(t.execution.error, errRe);
    assert.equal(redis.ttl[KEY], null, "persisted with no TTL: never auto-clears");
    assert.equal(res.body.fusedVerdict.execution.status, "UNKNOWN");
    assert.match(sent[0], /CHECK YOUR BROKER/);
    assert.ok(sent[0].includes(t.id));
    const res2 = await post(bearAlert());
    assert.equal(res2.body.decision, "BLOCKED_BY_ACTIVE_TRADE");
    assert.equal(calls.length, 1, "never retried, never re-dispatched");
    // The auto-lifecycle must not clear it either, even on an SL-crossing price.
    assert.equal(await webhook.evaluateActiveTradeLifecycle(25100, 25100, 25100, redis), null);
    assert.equal(stored(redis).id, t.id);
  }));
}

test("missing stop/targets: approved signal is NOT dispatched and the lock is released", bridgeCase({ env: BRIDGE_ON }, async ({ redis, calls, sent }) => {
  const res = await post(bearAlert({ sl: null, cappedSl: null, rDist: null, t1Dist: null, t2Dist: null }));
  assert.equal(res.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(calls.length, 0);
  assert.equal(res.body.fusedVerdict.execution.status, "NOT_EXECUTED");
  assert.match(res.body.fusedVerdict.execution.reason, /missing\/invalid sl, t1, t2/);
  assert.equal(stored(redis), null);
  assert.match(sent[0], /APPROVED BUT NOT EXECUTED/);
}));

// ── Atomic lock ──

test("concurrent actionable alerts: exactly one trade and one dispatch", bridgeCase({ env: BRIDGE_ON }, async ({ redis, calls }) => {
  const results = await Promise.all([post(bearAlert()), post(bearAlert()), post(bearAlert({ grade: "BULL_TRAP_SELL" }))]);
  const decisions = results.map((r) => r.body.decision).sort();
  const opened = decisions.filter((d) => d.startsWith("EXECUTE"));
  assert.equal(opened.length, 1, `one winner, got ${decisions.join(",")}`);
  assert.equal(decisions.filter((d) => d === "BLOCKED_BY_ACTIVE_TRADE").length, 2);
  assert.equal(calls.length, 1, "one dispatch");
  const winner = results.find((r) => r.body.decision.startsWith("EXECUTE"));
  assert.equal(stored(redis).id, winner.body.fusedVerdict.tradeId);
  assert.equal(JSON.parse(calls[0].init.body).id, winner.body.fusedVerdict.tradeId);
  for (const r of results) if (r !== winner) assert.equal(r.body.fusedVerdict.tradeId, undefined);
}));

test("concurrent paper alerts (bridge off): still exactly one trade", bridgeCase({}, async ({ redis, calls }) => {
  const results = await Promise.all([post(bearAlert()), post(bearAlert())]);
  assert.equal(results.filter((r) => r.body.decision.startsWith("EXECUTE")).length, 1);
  assert.equal(calls.length, 0);
  assert.ok(stored(redis).active);
}));

// ── Exit matching & sync-back ──

const ownedTrade = (status = "ACCEPTED", extra = {}) => ({
  active: true, id: "ft-owned-1", grade: "SYNERGY_BEAR", direction: "SHORT", timeframe: "15",
  entryPrice: 24960, stopLoss: 25025, riskPoints: 65, target1Price: 24895, target2Price: 24830,
  target1Dist: 65, target2Dist: 130, execution: { status, mode: "live", orderRef: "ORD-9" }, ...extra,
});
const exitBody = (grade, extra = {}) => ({ secret: SECRET, grade, source: "algo", spot: 25025, optionFill: 88.5, lots: 1, mode: "live", t: 1762841000000, ...extra });

test("exit with wrong tradeId -> 409, no state change", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade()) } }, async ({ redis }) => {
  const before = redis.store[KEY];
  const res = await post(exitBody("STOP_LOSS_HIT", { tradeId: "ft-someone-else" }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "TRADE_ID_MISMATCH");
  assert.equal(redis.store[KEY], before);
  assert.deepEqual(redis.lists, {}, "nothing archived");
}));

test("exit with a tradeId but no active trade -> 409", bridgeCase({}, async ({ redis }) => {
  const res = await post(exitBody("TARGET_2_HIT", { tradeId: "ft-x" }));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(redis.lists, {});
}));

test("paper trade with wrong tradeId -> 409 too", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("ACCEPTED", { execution: undefined })) } }, async ({ redis }) => {
  const res = await post(exitBody("STOP_LOSS_HIT", { tradeId: "nope" }));
  assert.equal(res.statusCode, 409);
  assert.ok(redis.store[KEY]);
}));

for (const status of ["ACCEPTED", "UNKNOWN", "PENDING", "FILLED"]) {
  test(`bridge-owned (${status}) trade: exit without tradeId (e.g. TradingView) -> 409`, bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade(status)) } }, async ({ redis }) => {
    const before = redis.store[KEY];
    const res = await post({ secret: SECRET, grade: "STOP_LOSS_HIT", close: 25025 });
    assert.equal(res.statusCode, 409);
    assert.equal(redis.store[KEY], before);
  }));
}

test("paper trade without id: legacy exit without tradeId still closes it", bridgeCase({
  initial: { [KEY]: JSON.stringify(ownedTrade("ACCEPTED", { execution: undefined, id: undefined })) },
}, async ({ redis }) => {
  const res = await post({ secret: SECRET, grade: "STOP_LOSS_HIT", close: 25025 });
  assert.equal(res.statusCode, 200);
  assert.equal(stored(redis), null);
}));

test("bridge-owned trade is ignored by the auto-lifecycle (direct call and GET ?spot)", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade()) } }, async ({ redis }) => {
  const before = redis.store[KEY];
  assert.equal(await webhook.evaluateActiveTradeLifecycle(24800, 24800, 24800, redis), null, "T2-crossing price ignored");
  assert.equal(await webhook.evaluateActiveTradeLifecycle(25100, 25100, 25100, redis), null, "SL-crossing price ignored");
  const res = await get({ spot: "24800", high: "25100", low: "24800" });
  assert.equal(res.statusCode, 200);
  assert.equal(redis.store[KEY], before);
}));

test("sync-back: T1 then T2 with matching tradeId drive the bridge-owned trade and close it", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade()) } }, async ({ redis }) => {
  const r1 = await post(exitBody("TARGET_1_HIT", { tradeId: "ft-owned-1", spot: 24895, optionFill: 120.5 }));
  assert.equal(r1.statusCode, 200);
  const t = stored(redis);
  assert.equal(t.hitT1, true);
  assert.equal(t.stopLoss, 24960, "SL to cost");
  assert.equal(t.t1HitPrice, 24895, "spot used as fill level");
  assert.equal(t.lastSync.optionFill, 120.5);
  assert.equal(r1.body.record.sync.tradeId, "ft-owned-1");
  const r2 = await post(exitBody("TARGET_2_HIT", { tradeId: "ft-owned-1", spot: 24830, optionFill: 180 }));
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.event, "TRADE_CLOSED");
  assert.equal(r2.body.exitRecord.exitPrice, 24830);
  assert.equal(r2.body.exitRecord.trade.id, "ft-owned-1");
  assert.deepEqual(r2.body.exitRecord.sync, { source: "algo", tradeId: "ft-owned-1", spot: 24830, optionFill: 180, lots: 1, mode: "live", t: 1762841000000 });
  assert.equal(stored(redis), null, "flat");
}));

test("sync-back: STOP_LOSS_HIT closes the matching trade; UNKNOWN resolved to FILLED by a matching T1", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("UNKNOWN")) } }, async ({ redis }) => {
  await post(exitBody("TARGET_1_HIT", { tradeId: "ft-owned-1", spot: 24895 }));
  assert.equal(stored(redis).execution.status, "FILLED");
  assert.equal(stored(redis).execution.resolvedBy, "sync-back");
  const r = await post(exitBody("BREAKEVEN_STOP", { tradeId: "ft-owned-1", spot: 24960 }));
  assert.equal(r.statusCode, 200);
  assert.equal(stored(redis), null);
}));

test("end-to-end: accepted dispatch -> Algo SL sync-back closes exactly that trade -> next alert dispatches", bridgeCase({ env: BRIDGE_ON }, async ({ redis, calls }) => {
  const res = await post(bearAlert());
  const id = res.body.fusedVerdict.tradeId;
  assert.equal((await post(exitBody("STOP_LOSS_HIT", { tradeId: "stale-id" }))).statusCode, 409);
  const exit = await post(exitBody("STOP_LOSS_HIT", { tradeId: id }));
  assert.equal(exit.statusCode, 200);
  assert.equal(exit.body.exitRecord.trade.id, id);
  assert.equal(stored(redis), null);
  await post(bearAlert());
  assert.equal(calls.length, 2);
  assert.notEqual(JSON.parse(calls[1].init.body).id, id);
}));

test("GET close_trade on a bridge-owned trade needs its tradeId", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("UNKNOWN")) } }, async ({ redis }) => {
  const r1 = await get({ close_trade: "1" });
  assert.equal(r1.statusCode, 409);
  assert.ok(stored(redis));
  const r2 = await get({ close_trade: "1", tradeId: "wrong" });
  assert.equal(r2.statusCode, 409);
  const r3 = await get({ close_trade: "1", tradeId: "ft-owned-1", reason: "MANUAL_CLOSE" });
  assert.equal(r3.statusCode, 200);
  assert.equal(stored(redis), null);
}));

// ── Contract v1.1: ENTRY_FILLED / ENTRY_FAILED, FILLED ownership, stuck-ACCEPTED guard ──

const filledBody = (extra = {}) => ({ secret: SECRET, grade: "ENTRY_FILLED", tradeId: "ft-owned-1", source: "algo", spot: 24958, optionFill: 112.35, contract: "NIFTY17NOV2624950PE", lots: 1, mode: "live", t: 1762841000000, ...extra });
const failedBody = (extra = {}) => ({ secret: SECRET, grade: "ENTRY_FAILED", tradeId: "ft-owned-1", source: "algo", reason: "broker rejected: margin", mode: "live", t: 1762841000000, ...extra });
const archive = (redis) => (redis.lists["nifty:tv:signals:master_archive"] || []).map((s) => JSON.parse(s));

for (const from of ["PENDING", "ACCEPTED", "UNKNOWN"]) {
  test(`ENTRY_FILLED from ${from}: FILLED with fill details, lock held, Telegram; repeat is a 200 no-op`, bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade(from)) } }, async ({ redis, sent }) => {
    const r = await post(filledBody());
    assert.equal(r.statusCode, 200);
    const t = stored(redis);
    assert.equal(t.active, true);
    assert.equal(t.execution.status, "FILLED");
    assert.equal(t.execution.previousStatus, from);
    assert.equal(t.execution.optionFill, 112.35);
    assert.equal(t.execution.contract, "NIFTY17NOV2624950PE");
    assert.equal(t.execution.mode, "live");
    assert.equal(t.execution.filledAt, new Date(1762841000000).toISOString());
    assert.equal(redis.ttl[KEY], 604800, "normal TTL once filled");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /ENTRY FILLED/);
    assert.ok(sent[0].includes("NIFTY17NOV2624950PE") && sent[0].includes("112.35"));
    assert.equal(archive(redis)[0].type, "ENTRY_FILLED");
    const before = redis.store[KEY];
    const again = await post(filledBody({ optionFill: 999 }));
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(redis.store[KEY], before, "no state change on repeat");
    assert.equal(sent.length, 1, "no second Telegram");
    assert.equal(archive(redis).length, 1);
  }));

  test(`ENTRY_FAILED from ${from}: NOT_EXECUTED, lock released, archived, Telegram; repeat is a 200 no-op`, bridgeCase({ env: BRIDGE_ON, initial: { [KEY]: JSON.stringify(ownedTrade(from)) } }, async ({ redis, sent, calls }) => {
    const r = await post(failedBody());
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.execution.status, "NOT_EXECUTED");
    assert.equal(r.body.execution.reason, "broker rejected: margin");
    assert.equal(stored(redis), null, "lock released");
    const rec = archive(redis)[0];
    assert.equal(rec.type, "ENTRY_FAILED");
    assert.equal(rec.trade.id, "ft-owned-1");
    assert.equal(rec.trade.execution.status, "NOT_EXECUTED");
    assert.match(sent[0], /APPROVED BUT NOT EXECUTED/);
    assert.ok(sent[0].includes("broker rejected: margin"));
    const again = await post(failedBody());
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(sent.length, 1);
    assert.equal(archive(redis).length, 1);
    // The next signal is free to open and dispatch.
    const next = await post(bearAlert());
    assert.equal(next.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
    assert.equal(calls.length, 1);
  }));
}

test("ENTRY_FAILED on a FILLED trade: 409, loud Telegram, state unchanged", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("FILLED", { execution: { status: "FILLED", contract: "NIFTYPE", optionFill: 100 } })) } }, async ({ redis, sent }) => {
  const before = redis.store[KEY];
  const r = await post(failedBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "CONTRADICTORY_REPORT");
  assert.equal(redis.store[KEY], before);
  assert.match(sent[0], /CONTRADICTORY/);
  assert.deepEqual(redis.lists, {});
}));

test("ENTRY_FILLED after ENTRY_FAILED (lock released): 409 with a loud Telegram", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("ACCEPTED")) } }, async ({ sent }) => {
  await post(failedBody());
  const r = await post(filledBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "CONTRADICTORY_REPORT");
  assert.match(sent[1], /CONTRADICTORY/);
}));

for (const [name, body] of [
  ["ENTRY_FILLED wrong tradeId", () => filledBody({ tradeId: "ft-other" })],
  ["ENTRY_FAILED wrong tradeId", () => failedBody({ tradeId: "ft-other" })],
  ["ENTRY_FILLED without tradeId", () => filledBody({ tradeId: undefined })],
  ["ENTRY_FAILED without tradeId", () => failedBody({ tradeId: undefined })],
]) {
  test(`${name}: 409, no state change`, bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("ACCEPTED")) } }, async ({ redis, sent }) => {
    const before = redis.store[KEY];
    const r = await post(body());
    assert.equal(r.statusCode, 409);
    assert.equal(redis.store[KEY], before);
    assert.deepEqual(redis.lists, {});
    assert.equal(sent.length, 0);
  }));
}

test("ENTRY_FILLED / ENTRY_FAILED need the webhook secret", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("ACCEPTED")) } }, async ({ redis }) => {
  const before = redis.store[KEY];
  assert.equal((await post(filledBody({ secret: "wrong" }))).statusCode, 401);
  assert.equal((await post(failedBody({ secret: undefined }))).statusCode, 401);
  assert.equal(redis.store[KEY], before);
}));

test("ENTRY_FILLED / ENTRY_FAILED on a paper trade: 409", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("ACCEPTED", { execution: undefined })) } }, async ({ redis }) => {
  const before = redis.store[KEY];
  assert.equal((await post(filledBody())).statusCode, 409);
  assert.equal((await post(failedBody())).statusCode, 409);
  assert.equal(redis.store[KEY], before);
}));

test("FILLED trade is Algo-owned: auto-lifecycle skips it, exits need the matching tradeId", bridgeCase({ initial: { [KEY]: JSON.stringify(ownedTrade("FILLED")) } }, async ({ redis }) => {
  assert.equal(await webhook.evaluateActiveTradeLifecycle(25100, 25100, 25100, redis), null);
  assert.ok(stored(redis));
  assert.equal((await post({ secret: SECRET, grade: "STOP_LOSS_HIT", close: 25025 })).statusCode, 409);
  assert.equal((await post(exitBody("STOP_LOSS_HIT", { tradeId: "ft-owned-1" }))).statusCode, 200);
  assert.equal(stored(redis), null);
}));

test("end-to-end v1.1: accepted -> ENTRY_FILLED -> Algo T2 closes it", bridgeCase({ env: BRIDGE_ON }, async ({ redis, sent }) => {
  const res = await post(bearAlert());
  const id = res.body.fusedVerdict.tradeId;
  assert.equal(stored(redis).execution.status, "ACCEPTED");
  assert.equal((await post(filledBody({ tradeId: id }))).statusCode, 200);
  assert.equal(stored(redis).execution.status, "FILLED");
  assert.equal((await post(exitBody("TARGET_2_HIT", { tradeId: id, spot: 24830 }))).statusCode, 200);
  assert.equal(stored(redis), null);
  assert.match(sent[0], /AWAITING FILL/);
  assert.match(sent[1], /ENTRY FILLED/);
}));

// Stuck-ACCEPTED guard
const acceptedAgo = (sec) => ownedTrade("ACCEPTED", { execution: { status: "ACCEPTED", mode: "live", orderRef: "ORD-9", at: new Date(Date.now() - sec * 1000).toISOString() } });

test("stuck ACCEPTED: one Telegram across repeated lifecycle checks and webhooks, state untouched", bridgeCase({ env: BRIDGE_ON, initial: { [KEY]: JSON.stringify(acceptedAgo(300)) } }, async ({ redis, sent, calls }) => {
  const before = redis.store[KEY];
  assert.equal(await webhook.evaluateActiveTradeLifecycle(24950, 24950, 24950, redis), null);
  await webhook.evaluateActiveTradeLifecycle(24950, 24950, 24950, redis);
  const blocked = await post(bearAlert());
  assert.equal(blocked.body.decision, "BLOCKED_BY_ACTIVE_TRADE");
  await get({ spot: "24950" });
  const stuck = sent.filter((t) => /NO FILL REPORT FROM ALGO/.test(t));
  assert.equal(stuck.length, 1, "exactly one alert");
  assert.ok(stuck[0].includes("ft-owned-1"));
  assert.equal(redis.store[KEY], before, "state left alone");
  assert.ok(redis.store["nifty:tv:bridge:stuck_alert:ft-owned-1"], "dedupe marker set");
  assert.equal(calls.length, 0);
}));

test("stuck guard: quiet within FLOW_BRIDGE_FILL_WAIT_SEC, and for FILLED / UNKNOWN / PENDING", bridgeCase({ env: { FLOW_BRIDGE_FILL_WAIT_SEC: "600" }, initial: { [KEY]: JSON.stringify(acceptedAgo(300)) } }, async ({ redis, sent }) => {
  await webhook.evaluateActiveTradeLifecycle(24950, 24950, 24950, redis);
  assert.equal(sent.length, 0, "300s < 600s");
  for (const status of ["FILLED", "UNKNOWN", "PENDING"]) {
    redis.store[KEY] = JSON.stringify(ownedTrade(status, { execution: { status, at: new Date(Date.now() - 3600_000).toISOString() } }));
    await webhook.evaluateActiveTradeLifecycle(24950, 24950, 24950, redis);
  }
  assert.equal(sent.length, 0);
}));

test("stuck guard default wait is 120s", () => {
  assert.equal(bridge.getFillWaitSec({}), 120);
  const now = Date.now();
  const t = (sec) => ({ active: true, execution: { status: "ACCEPTED", at: new Date(now - sec * 1000).toISOString() } });
  assert.equal(bridge.isStuckAccepted(t(100), now, 120), false);
  assert.equal(bridge.isStuckAccepted(t(121), now, 120), true);
});
