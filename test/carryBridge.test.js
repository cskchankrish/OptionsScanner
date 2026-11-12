/**
 * Overnight carry bridge (BTST/STBT): dispatcher conditions, one-per-day claim, outcomes,
 * CARRY_* sync-back, conversion MANUAL_CLOSE, no blocking of intraday validation, Telegram
 * wording and the status page. All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_MAX_AGE_SEC",
  "FLOW_BRIDGE_ENABLED", "FLOW_BRIDGE_URL", "FLOW_BRIDGE_SECRET", "FLOW_BRIDGE_DECISIONS", "FLOW_BRIDGE_TIMEOUT_MS",
  "CARRY_BRIDGE_ENABLED", "FLOW_ALGO_SQUAREOFF_TIME",
]) delete process.env[k];

const carry = await import("../src/carryBridge.js");
const webhook = await import("../api/tv-webhook.js");
const { createBridgeStatusHandler, resetBridgeStatusMemoryForTesting } = await import("../api/bridge-status.js");

const URL_ = "https://algo.example.test/flow-order";
const HMAC_KEY = "carry-test-hmac";
const SECRET = "carry-test-webhook-secret";
const ENV_ON = { CARRY_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: URL_, FLOW_BRIDGE_SECRET: HMAC_KEY };
const DATE = "2026-11-12"; // Thursday
const THU = 4;
// IST minute m on DATE -> epoch ms.
const at = (m, s = 0) => Date.UTC(2026, 10, 12, 0, 0, s) + (m - 330) * 60_000;
const TS_FRESH = "12-Nov-2026 15:30:00";

const tick = () => new Promise((r) => setImmediate(r));

function fakeStore() {
  const data = {};
  const ttl = {};
  const lists = {};
  return {
    data, ttl, lists,
    async get(k) { await tick(); return data[k] === undefined ? null : JSON.parse(JSON.stringify(data[k])); },
    async set(k, v, t) { await tick(); data[k] = JSON.parse(JSON.stringify(v)); ttl[k] = t ?? null; return "OK"; },
    async setNx(k, v, t) { await tick(); if (k in data) return false; data[k] = v; ttl[k] = t ?? null; return true; },
    async del(k) { await tick(); delete data[k]; delete ttl[k]; return 1; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim() { return "OK"; },
  };
}

const stbt = (o = {}) => ({ bias: "BEARISH", verdict: "CARRY NIFTY PE (STBT)", score: -5, agreement: { value: 75 }, stopLoss: 24100, ...o });
const btst = (o = {}) => ({ bias: "BULLISH", verdict: "CARRY NIFTY CE (BTST)", score: 5, agreement: { value: 80 }, stopLoss: 23900, ...o });

function harness({ env = ENV_ON, algo } = {}) {
  const store = fakeStore();
  const sent = [];
  const calls = [];
  let seq = 0;
  let nowMs = at(931);
  const deps = {
    env: () => env,
    now: () => nowMs,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return algo ? algo(url, init) : new Response(JSON.stringify({ status: "accepted", reason: null, mode: "live", orderRef: "C-1" }), { status: 200 });
    },
    sendText: async (t) => { sent.push(t); return true; },
    newId: (ms) => `ct-${ms}-${String(++seq).padStart(8, "0")}`,
  };
  const poll = (m, { decision = stbt(), spot = 24000, ts = TS_FRESH, dow = THU, sec = 0, deadline = null } = {}) => {
    nowMs = at(m, sec);
    return carry.runCarryDispatch({ istMinutes: m, istDateStr: DATE, dayOfWeek: dow, eodDecision: decision, spot, dataTimestamp: ts, deadlineMs: deadline, store, deps });
  };
  return { store, sent, calls, deps, poll, setNow: (ms) => { nowMs = ms; } };
}

// ── Disabled = no behaviour ──

for (const [name, env] of [
  ["flag unset", { FLOW_BRIDGE_URL: URL_, FLOW_BRIDGE_SECRET: HMAC_KEY }],
  ["flag true but no URL", { CARRY_BRIDGE_ENABLED: "true", FLOW_BRIDGE_SECRET: HMAC_KEY }],
  ["flag true but no secret", { CARRY_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: URL_ }],
]) {
  test(`disabled (${name}): nothing recorded, sent or reported`, async () => {
    const h = harness({ env });
    for (const m of [931, 932, 933, 934, 938]) assert.equal((await h.poll(m)).status, "DISABLED");
    assert.deepEqual(h.store.data, {});
    assert.equal(h.calls.length, 0);
    assert.equal(h.sent.length, 0);
  });
}

test("carry flag is independent of FLOW_BRIDGE_ENABLED (only URL + secret are shared)", () => {
  assert.equal(carry.getCarryConfig({ ...ENV_ON, FLOW_BRIDGE_ENABLED: "false" }).enabled, true);
  const c = carry.getCarryConfig(ENV_ON);
  assert.deepEqual([c.windowStartMins, c.windowEndMins, c.reportMins, c.requiredPolls, c.minAgreement], [931, 937, 938, 3, 65]);
  const o = carry.getCarryConfig({ ...ENV_ON, CARRY_WINDOW_START: "15:32", CARRY_WINDOW_END: "15:36", CARRY_REQUIRED_POLLS: "2", CARRY_MIN_AGREEMENT: "75" });
  assert.deepEqual([o.windowStartMins, o.windowEndMins, o.requiredPolls, o.minAgreement], [932, 936, 2, 75]);
});

test("NSE timestamp parsing (IST)", () => {
  assert.equal(carry.parseNseTimestamp("12-Nov-2026 15:30:00"), at(930));
  assert.equal(carry.parseNseTimestamp("garbage"), null);
  assert.equal(carry.parseNseTimestamp(null), null);
});

// ── Happy path ──

test("happy path STBT: 3 stable polls -> one signed CARRY_ENTRY, accepted, recorded without expiry", async () => {
  const h = harness();
  assert.equal((await h.poll(931)).status, "BLOCKED");
  assert.equal((await h.poll(932)).status, "BLOCKED");
  const r = await h.poll(933);
  assert.equal(r.status, "DISPATCHED");
  assert.equal(r.outcome, "ACCEPTED");
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, URL_);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["v", "type", "id", "ts", "verdict", "dir", "spot", "sl", "score", "agreement", "lots"]);
  assert.deepEqual(
    { v: body.v, type: body.type, verdict: body.verdict, dir: body.dir, spot: body.spot, sl: body.sl, score: body.score, agreement: body.agreement, lots: body.lots },
    { v: 1, type: "CARRY_ENTRY", verdict: "STBT", dir: "SHORT", spot: 24000, sl: 24100, score: -5, agreement: 75, lots: 1 },
  );
  assert.match(body.id, /^ct-\d+-[0-9a-f]{8}$/);
  assert.equal(body.ts, at(933));
  assert.equal(init.headers["X-Flow-Timestamp"], String(body.ts));
  assert.equal(init.headers["X-Flow-Signature"], createHmac("sha256", HMAC_KEY).update(`${body.ts}.${init.body}`).digest("hex"));
  const active = h.store.data[carry.CARRY_ACTIVE_KEY];
  assert.equal(active.id, body.id);
  assert.equal(active.execution.status, "ACCEPTED");
  assert.equal(h.store.ttl[carry.CARRY_ACTIVE_KEY], null, "no expiry while open");
  assert.ok(h.store.data[carry.carryClaimKey(DATE)]);
  assert.match(h.sent[0], /CARRY CONDITIONS MET · INSTRUCTION SENT/);
  assert.match(h.sent[0], /15:31 STBT.*15:32 STBT.*15:33 STBT/);
  assert.ok(h.sent[0].includes(body.id) && h.sent[0].includes("24100"));
  assert.match(h.sent[1], /SENT TO ALGO · AWAITING FILL/);
});

test("happy path BTST: dir LONG, stop below the reference", async () => {
  const h = harness();
  for (const m of [931, 932]) await h.poll(m, { decision: btst() });
  const r = await h.poll(933, { decision: btst() });
  assert.equal(r.status, "DISPATCHED");
  assert.deepEqual([r.entry.dir, r.entry.sl, r.entry.spot, r.entry.lots], ["LONG", 23900, 24000, 1]);
});

// ── Each condition failing on its own ──

const failCases = [
  ["not a weekday", { dow: 6 }, /not a regular weekday session/],
  ["NO_CARRY verdict", { decision: stbt({ bias: "NEUTRAL" }) }, /EOD verdict is NO_CARRY/],
  ["agreement below minimum", { decision: stbt({ agreement: { value: 60 } }) }, /agreement 60 < 65/],
  ["no real NSE spot", { spot: null }, /no real NSE spot/],
  ["option-chain timestamp missing", { ts: null }, /timestamp unreadable/],
  ["option-chain snapshot stale", { ts: "12-Nov-2026 15:00:00" }, /not fresh \(age 1980s > 900s\)/],
  ["stop on the wrong side", { decision: stbt({ stopLoss: 23950 }) }, /stop 23950 is on the wrong side of reference 24000 for SHORT/],
  ["no stop level", { decision: stbt({ stopLoss: null }) }, /no stop level/],
  ["poll request too close to its deadline", { get deadline() { return Date.now() + 5000; } }, /not enough request time left/],
];
for (const [name, third, re] of failCases) {
  test(`condition fails alone: ${name} -> no dispatch, reason recorded`, async () => {
    const h = harness();
    await h.poll(931);
    await h.poll(932);
    const r = await h.poll(933, third);
    assert.equal(r.status, "BLOCKED");
    assert.match(r.reason, re);
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.data[carry.carryClaimKey(DATE)], undefined);
    assert.match(h.store.data[carry.carryBlockKey(DATE)].reason, re);
  });
}

test("condition fails alone: category not identical on the last 3 polls", async () => {
  const h = harness();
  await h.poll(931);
  await h.poll(932, { decision: btst() });
  const r = await h.poll(933);
  assert.equal(r.status, "BLOCKED");
  assert.match(r.reason, /STBT not stable on the last 3 polls \(15:31 STBT, 15:32 BTST, 15:33 STBT\)/);
  assert.equal(h.calls.length, 0);
  // Stable again two polls later.
  await h.poll(934);
  assert.equal((await h.poll(935)).status, "DISPATCHED");
});

test("condition fails alone: polls closer than the minimum gap count once", async () => {
  const h = harness();
  await h.poll(931, { sec: 0 });
  await h.poll(931, { sec: 10 });
  const r = await h.poll(931, { sec: 20 });
  assert.equal(r.status, "BLOCKED");
  assert.match(r.reason, /not stable/);
  assert.equal(h.store.data[carry.carryPollsKey(DATE)].length, 1);
});

test("condition fails alone: a previous carry is still open", async () => {
  const h = harness();
  h.store.data[carry.CARRY_ACTIVE_KEY] = { id: "ct-old", execution: { status: "FILLED" } };
  await h.poll(931);
  await h.poll(932);
  const r = await h.poll(933);
  assert.match(r.reason, /previous carry ct-old is still open \(FILLED\)/);
  assert.equal(h.calls.length, 0);
});

test("outside the 15:31–15:37 window nothing is recorded or sent", async () => {
  const h = harness();
  assert.equal((await h.poll(930)).status, "OUTSIDE_WINDOW");
  assert.equal((await h.poll(941)).status, "OUTSIDE_WINDOW");
  assert.deepEqual(h.store.data, {});
});

// ── One dispatch per day ──

test("concurrent polls: exactly one dispatch per IST date", async () => {
  const h = harness();
  await h.poll(931);
  await h.poll(932);
  const rs = await Promise.all([h.poll(933), h.poll(933), h.poll(933), h.poll(933)]);
  assert.equal(rs.filter((r) => r.status === "DISPATCHED").length, 1);
  assert.equal(h.calls.length, 1);
  // Later polls the same day never send again (claim kept even after the carry closes).
  delete h.store.data[carry.CARRY_ACTIVE_KEY];
  assert.equal((await h.poll(936)).status, "ALREADY_DISPATCHED");
  assert.equal(h.calls.length, 1);
});

test("unknown outcome (HTTP 500): UNKNOWN, claim and carry kept, loud Telegram, no resend", async () => {
  const h = harness({ algo: async () => new Response("boom", { status: 500 }) });
  await h.poll(931);
  await h.poll(932);
  const r = await h.poll(933);
  assert.equal(r.outcome, "UNKNOWN");
  const active = h.store.data[carry.CARRY_ACTIVE_KEY];
  assert.equal(active.execution.status, "UNKNOWN");
  assert.equal(h.store.ttl[carry.CARRY_ACTIVE_KEY], null);
  assert.ok(h.store.data[carry.carryClaimKey(DATE)]);
  assert.match(h.sent.join("\n"), /CARRY OUTCOME UNKNOWN — CHECK YOUR BROKER NOW/);
  await h.poll(934);
  await h.poll(935);
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.data[carry.CARRY_ACTIVE_KEY].execution.status, "UNKNOWN", "never auto-cleared");
});

test("timeout: UNKNOWN and the claim is kept", async () => {
  const h = harness({ algo: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  h.deps.env = () => ({ ...ENV_ON, FLOW_BRIDGE_TIMEOUT_MS: "1000" });
  await h.poll(931);
  await h.poll(932);
  const r = await h.poll(933);
  assert.equal(r.outcome, "UNKNOWN");
  assert.ok(h.store.data[carry.carryClaimKey(DATE)]);
});

for (const status of ["rejected", "duplicate"]) {
  test(`${status}: NOT_EXECUTED, carry released and archived, claim kept, Telegram with reason`, async () => {
    const h = harness({ algo: async () => new Response(JSON.stringify({ status, reason: "holding_limit", mode: "live" }), { status: 200 }) });
    await h.poll(931);
    await h.poll(932);
    const r = await h.poll(933);
    assert.equal(r.outcome, status.toUpperCase());
    assert.equal(h.store.data[carry.CARRY_ACTIVE_KEY], undefined);
    assert.ok(h.store.data[carry.carryClaimKey(DATE)]);
    assert.equal(h.store.lists[carry.CARRY_HISTORY_KEY][0].type, "CARRY_NOT_EXECUTED");
    assert.match(h.sent[1], /CARRY APPROVED BUT NOT EXECUTED.*holdinglimit|CARRY APPROVED BUT NOT EXECUTED.*holding/);
    assert.equal((await h.poll(934)).status, "ALREADY_DISPATCHED");
  });
}

// ── 15:38 "nothing sent" message ──

test("15:38 report: sent once with the failing condition", async () => {
  const h = harness();
  await h.poll(931, { decision: stbt({ agreement: { value: 50 } }) });
  await h.poll(932, { decision: stbt({ agreement: { value: 50 } }) });
  await h.poll(937, { decision: stbt({ agreement: { value: 55 } }) });
  const r = await h.poll(938);
  assert.equal(r.status, "REPORT_SENT");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Carry: nothing sent today.*agreement 55 < 65.*15:37/);
  assert.equal((await h.poll(939)).status, "REPORT_ALREADY_SENT");
  assert.equal((await h.poll(940)).status, "REPORT_ALREADY_SENT");
  assert.equal(h.sent.length, 1);
});

test("15:38 report: says when no poll ran in the window; not sent after a dispatch; not sent at weekends", async () => {
  const a = harness();
  await a.poll(938);
  assert.match(a.sent[0], /no poll ran inside 15:31–15:37 IST/);
  const b = harness();
  for (const m of [931, 932, 933]) await b.poll(m);
  assert.equal((await b.poll(938)).status, "REPORT_NOT_NEEDED");
  assert.equal(b.sent.filter((t) => /nothing sent today/.test(t)).length, 0);
  const c = harness();
  assert.equal((await c.poll(938, { dow: 0 })).status, "NOT_A_SESSION");
  assert.equal(c.sent.length, 0);
});

test("stuck ACCEPTED carry: one alert after the fill wait, state untouched", async () => {
  const h = harness();
  for (const m of [931, 932, 933]) await h.poll(m);
  const sentBefore = h.sent.length;
  await h.poll(934); // 60s after acceptance: quiet
  assert.equal(h.sent.filter((t) => /NO CARRY FILL REPORT/.test(t)).length, 0);
  await h.poll(936); // 180s > 120s
  await h.poll(937);
  const stuck = h.sent.filter((t) => /NO CARRY FILL REPORT/.test(t));
  assert.equal(stuck.length, 1);
  assert.ok(h.sent.length >= sentBefore + 1);
  assert.equal(h.store.data[carry.CARRY_ACTIVE_KEY].execution.status, "ACCEPTED");
});

// ── Webhook: sync-back, conversion close, no blocking, Telegram, status ──

function fakeRedis(initial = {}) {
  const store = { ...initial };
  const lists = {};
  return {
    store, lists,
    async get(k) { await tick(); return store[k] ?? null; },
    async set(k, v, opts = {}) { await tick(); if (opts.nx && k in store) return null; store[k] = v; return "OK"; },
    async del(k) { await tick(); if (k in store) { delete store[k]; return 1; } return 0; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim() { return "OK"; },
    async lrange(k) { return lists[k] || []; },
  };
}

function hook({ initial = {}, env = {} } = {}, fn) {
  return async () => {
    const prev = { TV_WEBHOOK_SECRET: process.env.TV_WEBHOOK_SECRET };
    process.env.TV_WEBHOOK_SECRET = SECRET;
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    const redis = fakeRedis(initial);
    const sent = [];
    const calls = [];
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({
      now: () => Date.now(),
      isLiveMarket: async () => false,
      refresh: async () => ({ ok: false, stage: "nse", error: "none" }),
      sendText: async (t) => { sent.push(t); return true; },
      bridgeFetch: async (u, init) => { calls.push({ u, init }); return new Response(JSON.stringify({ status: "accepted", mode: "live", orderRef: "X" }), { status: 200 }); },
      newTradeId: () => `ft-${Math.random().toString(16).slice(2, 10)}`,
    });
    try {
      await fn({ redis, sent, calls });
    } finally {
      webhook.setRedisClientForTesting(null);
      webhook.setWebhookDepsForTesting(null);
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}
async function post(body) {
  const req = { method: "POST", body: JSON.stringify(body), query: {}, headers: {} };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } };
  await webhook.default(req, res);
  return res;
}
async function get(query) {
  const req = { method: "GET", body: undefined, query: { key: SECRET, ...query }, headers: {} };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } };
  await webhook.default(req, res);
  return res;
}

const CK = carry.CARRY_ACTIVE_KEY;
const openCarry = (status = "ACCEPTED", extra = {}) => JSON.stringify({
  id: "ct-1", date: DATE, verdict: "STBT", dir: "SHORT", spot: 24000, sl: 24100, score: -5, agreement: 75, lots: 1,
  sentAt: "2026-11-12T10:03:00.000Z", execution: { status, mode: "live", at: "2026-11-12T10:03:01.000Z", ...extra },
});
const carryState = (redis) => (redis.store[CK] ? JSON.parse(redis.store[CK]) : null);
const accounts = [{ account: "ACC-A", lots: 1, fill: 101.5, pnl: 1450 }, { account: "ACC-B", lots: 1, fill: 101.8, pnl: 1430 }];
const filled = (o = {}) => ({ secret: SECRET, grade: "CARRY_FILLED", tradeId: "ct-1", source: "algo", lots: 1, optionFill: 101.6, contract: "NIFTY17NOV2624000PE", mode: "live", t: 1762941780000, accounts, converted: true, ...o });
const failed = (o = {}) => ({ secret: SECRET, grade: "CARRY_FAILED", tradeId: "ct-1", source: "algo", reason: "margin shortfall", mode: "live", t: 1762941780000, ...o });
const exited = (o = {}) => ({ secret: SECRET, grade: "CARRY_EXIT", tradeId: "ct-1", source: "algo", reason: "MORNING_EXIT", spot: 23890, optionFill: 130.2, lots: 1, mode: "live", t: 1762999980000, accounts, ...o });

for (const from of ["PENDING", "ACCEPTED", "UNKNOWN"]) {
  test(`CARRY_FILLED from ${from}: FILLED with contract, fill, accounts, converted; repeat 200 no-op`, hook({ initial: { [CK]: openCarry(from) } }, async ({ redis, sent }) => {
    const r = await post(filled());
    assert.equal(r.statusCode, 200);
    const c = carryState(redis);
    assert.equal(c.execution.status, "FILLED");
    assert.equal(c.execution.contract, "NIFTY17NOV2624000PE");
    assert.equal(c.execution.optionFill, 101.6);
    assert.equal(c.execution.converted, true);
    assert.deepEqual(c.execution.accounts, accounts);
    assert.match(sent[0], /CARRY FILLED BY ALGO/);
    assert.match(sent[0], /Converted from intraday position:\* YES/);
    assert.ok(sent[0].includes("ACC-A") && sent[0].includes("NIFTY17NOV2624000PE"));
    const before = redis.store[CK];
    const again = await post(filled({ optionFill: 1 }));
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(redis.store[CK], before);
    assert.equal(sent.length, 1);
  }));
}

test("CARRY_FAILED: released, archived, Telegram; repeat 200 no-op; FILLED afterwards is contradictory", hook({ initial: { [CK]: openCarry("ACCEPTED") } }, async ({ redis, sent }) => {
  const r = await post(failed());
  assert.equal(r.statusCode, 200);
  assert.equal(carryState(redis), null);
  assert.equal(JSON.parse(redis.lists[carry.CARRY_HISTORY_KEY][0]).type, "CARRY_FAILED");
  assert.match(sent[0], /CARRY APPROVED BUT NOT EXECUTED[\s\S]*margin shortfall/);
  assert.equal((await post(failed())).body.duplicate, true);
  const f = await post(filled());
  assert.equal(f.statusCode, 409);
  assert.equal(f.body.error, "CONTRADICTORY_REPORT");
  assert.match(sent[sent.length - 1], /CONTRADICTORY CARRY REPORTS/);
}));

test("CARRY_FAILED on a FILLED carry: 409, loud Telegram, state unchanged", hook({ initial: { [CK]: openCarry("FILLED", { contract: "PE" }) } }, async ({ redis, sent }) => {
  const before = redis.store[CK];
  const r = await post(failed());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "CONTRADICTORY_REPORT");
  assert.equal(redis.store[CK], before);
  assert.match(sent[0], /CONTRADICTORY CARRY REPORTS/);
}));

test("CARRY_EXIT: archives entry + exit details, clears the carry, Telegram with per-account P&L; repeat 200; FAILED after exit 409", hook({ initial: { [CK]: openCarry("FILLED", { contract: "NIFTY17NOV2624000PE", optionFill: 101.6, filledAt: "2026-11-12T10:03:30.000Z" }) } }, async ({ redis, sent }) => {
  const r = await post(exited());
  assert.equal(r.statusCode, 200);
  assert.equal(carryState(redis), null);
  const rec = JSON.parse(redis.lists[carry.CARRY_HISTORY_KEY][0]);
  assert.equal(rec.type, "CARRY_EXIT");
  assert.deepEqual([rec.verdict, rec.dir, rec.entry.spotRef, rec.entry.sl, rec.entry.contract, rec.entry.optionFill], ["STBT", "SHORT", 24000, 24100, "NIFTY17NOV2624000PE", 101.6]);
  assert.deepEqual([rec.exit.reason, rec.exit.spot, rec.exit.optionFill], ["MORNING_EXIT", 23890, 130.2]);
  assert.deepEqual(rec.exit.accounts, accounts);
  assert.match(sent[0], /CARRY EXITED[\s\S]*MORNINGEXIT|CARRY EXITED[\s\S]*MORNING/);
  assert.ok(sent[0].includes("pnl 1450") && sent[0].includes("ACC-B"));
  assert.equal((await post(exited())).body.duplicate, true);
  assert.equal(redis.lists[carry.CARRY_HISTORY_KEY].length, 1);
  assert.equal((await post(failed())).statusCode, 409);
}));

for (const [name, body] of [
  ["CARRY_FILLED wrong tradeId", filled({ tradeId: "ct-x" })],
  ["CARRY_EXIT wrong tradeId", exited({ tradeId: "ct-x" })],
  ["CARRY_FAILED no tradeId", failed({ tradeId: undefined })],
  ["CARRY_EXIT no tradeId", exited({ tradeId: undefined })],
]) {
  test(`${name}: 409, no state change`, hook({ initial: { [CK]: openCarry("FILLED") } }, async ({ redis, sent }) => {
    const before = redis.store[CK];
    const r = await post(body);
    assert.equal(r.statusCode, 409);
    assert.equal(redis.store[CK], before);
    assert.deepEqual(redis.lists, {});
    assert.equal(sent.length, 0);
  }));
}

test("CARRY_* sync-back requires the webhook secret", hook({ initial: { [CK]: openCarry("ACCEPTED") } }, async ({ redis }) => {
  const before = redis.store[CK];
  assert.equal((await post(filled({ secret: "nope" }))).statusCode, 401);
  assert.equal(redis.store[CK], before);
}));

test("conversion: MANUAL_CLOSE with reason 'converted to carry' closes the intraday trade and stores the reason", hook({
  initial: { "nifty:tv:active_trade": JSON.stringify({ active: true, id: "ft-intra", grade: "SYNERGY_BEAR", direction: "SHORT", timeframe: "15", entryPrice: 24060, stopLoss: 24125, riskPoints: 65, target1Price: 23995, target2Price: 23930, target1Dist: 65, target2Dist: 130, execution: { status: "FILLED" } }) },
}, async ({ redis }) => {
  const r = await post({ secret: SECRET, grade: "MANUAL_CLOSE", tradeId: "ft-intra", source: "algo", spot: 24000, optionFill: 99, lots: 1, mode: "live", t: 1, reason: "converted to carry" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.exitRecord.closeReason, "converted to carry");
  assert.equal(r.body.exitRecord.sync.reason, "converted to carry");
  assert.match(r.body.exitRecord.reasoning, /MANUAL_CLOSE: converted to carry/);
  assert.equal(redis.store["nifty:tv:active_trade"], undefined);
}));

const bearAlert = { secret: SECRET, sym: "NSE:NIFTY", tf: "15", dir: "SHORT", grade: "SYNERGY_BEAR", close: 24960, sl: 25025, cappedSl: 25025, rDist: 65, t1Dist: 65, t2Dist: 130 };
const freshSnap = () => JSON.stringify({ snapshotAt: Date.now() - 10_000, snapshotSource: "poller", corridor: { deltaPCR: 0.6, floorStrike: 24700, roofStrike: 25200 }, futures: { quadrant: "SHORT_BUILDUP" }, smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" } });

test("an open carry does NOT block intraday validation, and is shown in the alert and the status GET", hook({
  initial: { [CK]: openCarry("FILLED", { contract: "NIFTY17NOV2624000PE" }), "nifty:flow:latest": freshSnap() },
  env: { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: URL_, FLOW_BRIDGE_SECRET: HMAC_KEY },
}, async ({ redis, calls }) => {
  const r = await post(bearAlert);
  assert.equal(r.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.ok(redis.store["nifty:tv:active_trade"], "intraday trade opened");
  assert.equal(calls.length, 1, "intraday entry still dispatched");
  assert.equal(r.body.fusedVerdict.openCarry.id, "ct-1");
  const text = webhook.formatTelegramAlert(r.body.fusedVerdict);
  assert.match(text, /Open overnight carry:\* `STBT` \(SHORT\) · `FILLED`/);
  const s = await get({ status: "1" });
  assert.equal(s.body.openCarry.id, "ct-1");
  assert.equal(s.body.openCarry.status, "FILLED");
  assert.equal(carryState(redis).execution.status, "FILLED", "carry untouched");
}));

test("Telegram: bridge-owned entry shows the Algo protocol, paper entry keeps the paper protocol", () => {
  const base = {
    decision: "EXECUTE_HIGH_CONVICTION_SYNERGY", grade: "SYNERGY_BEAR", direction: "SHORT", symbol: "NSE:NIFTY", timeframe: "15", swingTimeframe: "125m",
    entryPrice: 24960, stopLoss: 25025, riskPoints: 65, target1Price: 24895, target2Price: 24830, target1Dist: 65, target2Dist: 130,
    recommendedLots: 2, tier: "HIGH_CONVICTION_SYNERGY", chartMetrics: {}, liveOptionChainMetrics: {}, reasoning: "r",
  };
  const algo = webhook.formatTelegramAlert({ ...base, tradeId: "ft-1", execution: { status: "ACCEPTED", mode: "live" } });
  for (const bad of ["Recommended Size", "2 Lot(s)", "Scale out 60%", "Fill at next bar open", "EXECUTION & EXIT PROTOCOL"]) {
    assert.ok(!algo.includes(bad), `algo text must not contain ${bad}`);
  }
  assert.match(algo, /1 lot per account immediately/);
  assert.match(algo, /moves the stop to entry/);
  assert.match(algo, /exits fully/);
  assert.match(algo, /square[d]? off at the Algo's configured square-off time/);
  process.env.FLOW_ALGO_SQUAREOFF_TIME = "15:15";
  try {
    assert.match(webhook.formatTelegramAlert({ ...base, execution: { status: "FILLED" } }), /squared off at 15:15 IST/);
  } finally {
    delete process.env.FLOW_ALGO_SQUAREOFF_TIME;
  }
  const notExec = webhook.formatTelegramAlert({ ...base, execution: { status: "NOT_EXECUTED", outcome: "REJECTED", reason: "x" } });
  assert.match(notExec, /not executed — no position/);
  const paper = webhook.formatTelegramAlert(base);
  for (const keep of ["Recommended Size", "2 Lot(s)", "Scale out 60%", "Fill at next bar open"]) assert.ok(paper.includes(keep), `paper keeps ${keep}`);
});

// ── Status page ──

async function statusCall({ env, query = {}, carryRecord = null }) {
  resetBridgeStatusMemoryForTesting();
  const prev = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = SECRET;
  try {
    const store = {};
    const handler = createBridgeStatusHandler({
      now: () => at(900),
      env: () => env,
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok", mode: "live", flowBridgeEnabled: true, accounts: [], feed: null, serverTime: at(900) }), { status: 200 }),
      setNx: async (k) => { if (k in store) return false; store[k] = 1; return true; },
      get: async (k) => store[k] ?? null,
      set: async (k, v) => { store[k] = v; return true; },
      getCarry: async () => carryRecord,
    });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
    await handler({ method: "GET", query, headers: {} }, res);
    return res;
  } finally {
    if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev;
  }
}

test("status page: carryEnabled in the public view; carry settings + open carry only for authenticated callers", async () => {
  const env = { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: URL_, FLOW_BRIDGE_SECRET: HMAC_KEY, CARRY_BRIDGE_ENABLED: "true" };
  const record = JSON.parse(openCarry("FILLED", { contract: "NIFTY17NOV2624000PE" }));
  const pub = await statusCall({ env, carryRecord: record });
  assert.equal(pub.body.carryEnabled, true);
  assert.equal(pub.body.detail, undefined);
  const auth = await statusCall({ env, query: { key: SECRET }, carryRecord: record });
  assert.equal(auth.body.detail.carry.settings.window, "15:31–15:37 IST");
  assert.equal(auth.body.detail.carry.settings.minAgreement, 65);
  assert.equal(auth.body.detail.carry.openCarry.id, "ct-1");
  assert.ok(!JSON.stringify(auth.body).includes(HMAC_KEY) && !JSON.stringify(auth.body).includes("/flow-order"));
  const off = await statusCall({ env: { ...env, CARRY_BRIDGE_ENABLED: "false" } });
  assert.equal(off.body.carryEnabled, false);
});
