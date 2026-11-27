/**
 * Shadow candidate alerts (*_CAND from Pine v4.3.1): judged against the real option chain, recorded
 * only — never an order, never Telegram, never the live signal log. All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_MAX_AGE_SEC", "FLOW_REFRESH_TIMEOUT_MS",
  "FLOW_BRIDGE_ENABLED", "FLOW_BRIDGE_URL", "FLOW_BRIDGE_SECRET", "FLOW_BRIDGE_DECISIONS", "FLOW_BRIDGE_TIMEOUT_MS",
  "CANDIDATE_SHADOW_ENABLED", "SCORECARD_ENABLED", "TV_ACK_DEADLINE_MS",
]) delete process.env[k];

const webhook = await import("../api/tv-webhook.js");
const cs = await import("../src/candidateShadow.js");
const sc = await import("../src/scorecard.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "cand-test-webhook-secret";
const BRIDGE_ON = { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://algo.example.test/flow", FLOW_BRIDGE_SECRET: "cand-test-hmac" };
const TG_ON = { TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_CHAT_ID: "123" };
const ACTIVE = "nifty:tv:active_trade";
const LATEST = "nifty:tv:latest_signal";
const ARCHIVE = "nifty:tv:signals:master_archive";

const tick = () => new Promise((r) => setImmediate(r));

function createFakeRedis(initial = {}) {
  const store = { ...initial };
  const ttl = {};
  const lists = {};
  const calls = [];
  return {
    store, ttl, lists, calls,
    async get(k) { calls.push(["get", k]); await tick(); return store[k] ?? null; },
    async set(k, v, opts = {}) {
      calls.push(["set", k]);
      await tick();
      if (opts.nx && k in store) return null;
      store[k] = v;
      ttl[k] = opts.ex ?? null;
      return "OK";
    },
    async del(k) { calls.push(["del", k]); await tick(); if (k in store) { delete store[k]; return 1; } return 0; },
    async lpush(k, v) { calls.push(["lpush", k]); (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim(k, a, b) { lists[k] = (lists[k] || []).slice(a, b + 1); return "OK"; },
    async lrange(k, a = 0, b = -1) { const l = lists[k] || []; return b === -1 ? l.slice(a) : l.slice(a, b + 1); },
    async expire(k, s) { ttl[k] = s; return 1; },
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

const alert = (grade, dir, extra = {}) => ({
  secret: SECRET, sym: "NSE:NIFTY", tf: "15", dir, grade, close: 24960,
  sl: dir === "LONG" ? 24895 : 25025, cappedSl: dir === "LONG" ? 24895 : 25025, rDist: 65, t1Dist: 65, t2Dist: 130,
  futQuad: dir === "LONG" ? "LONG_BUILDUP" : "SHORT_BUILDUP",
  ...extra,
});

// Snapshots that make the REAL grade execute with positive chain confirmation.
const bullSnap = (o = {}) => ({ snapshotAt: Date.now() - 20_000, snapshotSource: "poller", corridor: { deltaPCR: 1.4, floorStrike: 24900, roofStrike: 25400 }, futures: { quadrant: "LONG_BUILDUP" }, smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" }, ...o });
const bearSnap = (o = {}) => ({ snapshotAt: Date.now() - 20_000, snapshotSource: "poller", corridor: { deltaPCR: 0.6, floorStrike: 24500, roofStrike: 25000 }, futures: { quadrant: "SHORT_BUILDUP" }, smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" }, ...o });

const CASES = [
  { grade: "SYNERGY_BULL_CAND", real: "SYNERGY_BULL", dir: "LONG", snap: bullSnap, realDecision: "EXECUTE_HIGH_CONVICTION_SYNERGY" },
  { grade: "SYNERGY_BEAR_CAND", real: "SYNERGY_BEAR", dir: "SHORT", snap: bearSnap, realDecision: "EXECUTE_HIGH_CONVICTION_SYNERGY" },
  { grade: "BEAR_TRAP_BUY_CAND", real: "BEAR_TRAP_BUY", dir: "LONG", snap: bullSnap, realDecision: "EXECUTE_TIER1_SCOUT" },
  { grade: "BULL_TRAP_SELL_CAND", real: "BULL_TRAP_SELL", dir: "SHORT", snap: bearSnap, realDecision: "EXECUTE_TIER1_SCOUT" },
];

let idSeq = 0;
/** Webhook case: secret, fake Redis, every outbound path stubbed and counted. */
function hookCase({ env = {}, initial = {}, snap, live = true } = {}, fn) {
  return async () => {
    const allEnv = { TV_WEBHOOK_SECRET: SECRET, ...TG_ON, ...env };
    const prev = {};
    for (const [k, v] of Object.entries(allEnv)) { prev[k] = process.env[k]; process.env[k] = v; }
    const redis = createFakeRedis({ ...(snap ? { "nifty:flow:latest": JSON.stringify(snap) } : {}), ...initial });
    const sent = [];
    const bridgeCalls = [];
    const fetchCalls = [];
    const refreshCalls = [];
    const origFetch = globalThis.fetch;
    // Any Telegram sender (alert, exit, T1, EOD, text) goes through global fetch.
    globalThis.fetch = async (url, init) => { fetchCalls.push({ url: String(url), init }); return new Response("{}", { status: 200 }); };
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({
      now: () => Date.now(),
      isLiveMarket: async () => live,
      refresh: async () => { refreshCalls.push(1); return { ok: false, stage: "nse", error: "no refresh in tests" }; },
      sendText: async (t) => { sent.push(t); return true; },
      bridgeFetch: async (url, init) => { bridgeCalls.push({ url, init }); return new Response(JSON.stringify({ status: "accepted", reason: null, mode: "dry_run", orderRef: "ORD-1" }), { status: 200 }); },
      newTradeId: () => `ft-cand-${++idSeq}`,
    });
    try {
      await fn({ redis, sent, bridgeCalls, fetchCalls, refreshCalls });
    } finally {
      globalThis.fetch = origFetch;
      webhook.setRedisClientForTesting(null);
      webhook.setWebhookDepsForTesting(null);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

async function post(body) {
  const { req, res } = mockReqRes({ body });
  await webhook.default(req, res);
  return res;
}
async function get(query = {}) {
  const { req, res } = mockReqRes({ method: "GET", query });
  await webhook.default(req, res);
  return res;
}
const today = () => webhook.getIstDateString();
const candList = (redis) => (redis.lists[cs.candidateListKey(today())] || []).map((x) => JSON.parse(x));
const scEvents = (redis) => Object.entries(redis.lists).filter(([k]) => k.startsWith("nifty:sc:events:")).flatMap(([, l]) => l.map((x) => (typeof x === "string" ? JSON.parse(x) : x)));
const telegramCalls = (fetchCalls) => fetchCalls.filter((c) => c.url.includes("api.telegram.org"));

function assertNoLiveSideEffects({ redis, sent, bridgeCalls, fetchCalls }, { activeBefore = undefined } = {}) {
  assert.equal(bridgeCalls.length, 0, "bridgeFetch never called");
  // The only Telegram a candidate may send is its shadow verdict (test/candidateTelegram.test.js).
  assert.equal(sent.filter((t) => !String(t).startsWith("🧪 *SHADOW CANDIDATE*")).length, 0, "no other deps.sendText Telegram");
  assert.ok(sent.length <= 1, "at most one shadow verdict message");
  assert.equal(fetchCalls.length, 0, "no global fetch at all (no Telegram sender)");
  assert.equal(redis.store[ACTIVE], activeBefore, "nifty:tv:active_trade untouched");
  assert.equal(redis.calls.some(([op, k]) => k === ACTIVE && op !== "get"), false, "no write to the active-trade key");
  assert.equal(redis.calls.some(([, k]) => k === ACTIVE), false, "active-trade key not even read");
  assert.equal(redis.store[LATEST], undefined, "latest_signal untouched");
  assert.equal(redis.lists[`nifty:tv:signals:${today()}`], undefined, "daily signals list untouched");
  assert.equal(redis.lists[ARCHIVE], undefined, "master archive untouched");
}

// ── Handler: the four grades, bridge enabled, fresh confirming snapshot ──

for (const c of CASES) {
  test(`${c.grade}: CANDIDATE_SHADOW, no dispatch/Telegram/active trade/signal log; one record + one scorecard event`, hookCase({ env: BRIDGE_ON, snap: c.snap() }, async (ctx) => {
    const res = await post(alert(c.grade, c.dir));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      { ok: res.body.ok, event: res.body.event, grade: res.body.grade, realGrade: res.body.realGrade, category: res.body.category, decision: res.body.decision },
      { ok: true, event: "CANDIDATE_SHADOW", grade: c.grade, realGrade: c.real, category: "CONFIRMED", decision: "SHADOW_ONLY" },
    );
    assert.equal(res.body.realDecision, c.realDecision, "the real grade would have executed");
    assertNoLiveSideEffects(ctx);
    assert.equal(ctx.refreshCalls.length, 0, "no on-demand refresh");
    const list = candList(ctx.redis);
    assert.equal(list.length, 1);
    const r = list[0];
    assert.equal(r.grade, c.grade);
    assert.equal(r.realGrade, c.real);
    assert.equal(r.direction, c.dir);
    assert.equal(r.category, "CONFIRMED");
    assert.equal(r.realDecision, c.realDecision);
    assert.equal(r.entry, 24960);
    assert.ok(r.sl > 0 && r.t1 > 0 && r.t2 > 0);
    assert.equal(typeof r.realReasoning, "string");
    assert.equal(r.deltaPcr, c.dir === "LONG" ? 1.4 : 0.6);
    assert.equal(r.serverFutQuad, c.dir === "LONG" ? "LONG_BUILDUP" : "SHORT_BUILDUP");
    assert.equal(r.chartFutQuad, c.dir === "LONG" ? "LONG_BUILDUP" : "SHORT_BUILDUP");
    assert.ok(r.floor > 0 && r.roof > 0);
    assert.ok(Number.isInteger(r.snapshotAgeSec));
    assert.equal(ctx.redis.ttl[cs.candidateListKey(today())], 14 * 86400);
    const evs = scEvents(ctx.redis);
    assert.equal(evs.length, 1, "one scorecard event");
    assert.equal(evs[0].section, "CANDIDATE");
    assert.equal(evs[0].type, c.grade);
    assert.equal(evs[0].direction, c.dir === "LONG" ? "BULLISH" : "BEARISH");
    assert.equal(evs[0].data.category, "CONFIRMED");
    assert.equal(evs[0].data.realGrade, c.real);
    assert.equal(evs[0].data.decision, c.realDecision);
  }));
}

test("lower-case candidate grade is still handled as a candidate (never falls through)", hookCase({ env: BRIDGE_ON, snap: bullSnap() }, async (ctx) => {
  const res = await post(alert("synergy_bull_cand", "LONG"));
  assert.equal(res.body.event, "CANDIDATE_SHADOW");
  assert.equal(res.body.grade, "SYNERGY_BULL_CAND");
  assertNoLiveSideEffects(ctx);
}));

test("handler: stale and missing snapshots are UNVERIFIABLE, with no refresh even during market hours", async () => {
  await hookCase({ env: BRIDGE_ON, snap: bullSnap({ snapshotAt: Date.now() - 2_000_000 }) }, async (ctx) => {
    const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
    assert.equal(res.body.category, "UNVERIFIABLE");
    assert.equal(ctx.refreshCalls.length, 0);
    assertNoLiveSideEffects(ctx);
    assert.equal(scEvents(ctx.redis)[0].dq.ok, false);
  })();
  await hookCase({ env: BRIDGE_ON, snap: null, initial: { nifty_latest_session_payload_v2: JSON.stringify(bullSnap()) } }, async (ctx) => {
    const res = await post(alert("BEAR_TRAP_BUY_CAND", "LONG"));
    assert.equal(res.body.category, "UNVERIFIABLE", "no session-payload fallback");
    assert.equal(ctx.refreshCalls.length, 0);
    assertNoLiveSideEffects(ctx);
    assert.equal(candList(ctx.redis)[0].snapshotAgeSec, null);
  })();
});

// ── Active trade interplay ──

test("an existing active trade is unaffected by a candidate", async () => {
  const existing = JSON.stringify({ active: true, id: "ft-existing", grade: "SYNERGY_BEAR", direction: "SHORT", entryPrice: 25000, stopLoss: 25060, execution: { status: "FILLED" } });
  await hookCase({ env: BRIDGE_ON, snap: bullSnap(), initial: { [ACTIVE]: existing } }, async (ctx) => {
    const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
    assert.equal(res.body.event, "CANDIDATE_SHADOW");
    assertNoLiveSideEffects(ctx, { activeBefore: existing });
    assert.equal(ctx.redis.store[ACTIVE], existing, "byte-identical");
  })();
});

test("a candidate does not block a subsequent real alert; the real grade still dispatches exactly once", hookCase({ env: BRIDGE_ON, snap: bullSnap() }, async ({ redis, bridgeCalls, fetchCalls }) => {
  const c = await post(alert("SYNERGY_BULL_CAND", "LONG"));
  assert.equal(c.body.event, "CANDIDATE_SHADOW");
  assert.equal(bridgeCalls.length, 0);
  const r = await post(alert("SYNERGY_BULL", "LONG"));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(bridgeCalls.length, 1, "real grade dispatched once");
  const body = JSON.parse(bridgeCalls[0].init.body);
  assert.equal(body.grade, "SYNERGY_BULL");
  const t = JSON.parse(redis.store[ACTIVE]);
  assert.equal(t.active, true);
  assert.equal(t.grade, "SYNERGY_BULL");
  assert.ok(redis.store[LATEST], "real path still writes latest_signal");
  assert.equal(redis.lists[`nifty:tv:signals:${today()}`].length, 1, "only the real signal is in the daily list");
  assert.equal(redis.lists[ARCHIVE].length, 1);
  assert.ok(telegramCalls(fetchCalls).length >= 1, "real path still sends its Telegram alert");
  const secs = scEvents(redis).map((e) => e.section).sort();
  assert.deepEqual(secs, ["CANDIDATE", "SIGNAL"]);
}));

test("real SYNERGY_BULL alone behaves as before: approved and dispatched once", hookCase({ env: BRIDGE_ON, snap: bullSnap() }, async ({ redis, bridgeCalls }) => {
  const r = await post(alert("SYNERGY_BULL", "LONG"));
  assert.equal(r.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(bridgeCalls.length, 1);
  assert.equal(JSON.parse(redis.store[ACTIVE]).execution.status, "ACCEPTED");
  assert.equal(candList(redis).length, 0, "real alerts never write the candidate list");
}));

// ── Kill switch / grade helpers / exact-match guard ──

for (const v of ["false", "0", "FALSE"]) {
  test(`kill switch CANDIDATE_SHADOW_ENABLED=${v}: CANDIDATE_IGNORED and nothing else`, hookCase({ env: { ...BRIDGE_ON, CANDIDATE_SHADOW_ENABLED: v }, snap: bullSnap() }, async (ctx) => {
    const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, event: "CANDIDATE_IGNORED" });
    assertNoLiveSideEffects(ctx);
    assert.equal(candList(ctx.redis).length, 0);
    assert.equal(scEvents(ctx.redis).length, 0);
  }));
}

test("isCandidateShadowEnabled defaults on", () => {
  assert.equal(cs.isCandidateShadowEnabled({}), true);
  assert.equal(cs.isCandidateShadowEnabled({ CANDIDATE_SHADOW_ENABLED: "true" }), true);
  assert.equal(cs.isCandidateShadowEnabled({ CANDIDATE_SHADOW_ENABLED: " 0 " }), false);
});

test("isCandidateGrade / CANDIDATE_GRADES", () => {
  for (const c of CASES) {
    assert.equal(cs.isCandidateGrade(c.grade), true);
    assert.equal(cs.CANDIDATE_GRADES[c.grade], c.real);
    assert.equal(cs.realGradeFor(c.grade.toLowerCase()), c.real);
    assert.equal(cs.isCandidateGrade(c.real), false, "real grades are not candidates");
  }
  for (const g of [null, undefined, "", "MEGA", "SYNERGY_BULL_CANDX", "CAND", "TARGET_1_HIT", 42]) assert.equal(cs.isCandidateGrade(g), false);
});

test("exact-match guard: *_CAND grades are never actionable", () => {
  for (const c of CASES) {
    assert.equal(webhook.ACTIONABLE_GRADES.includes(c.grade), false);
    // The pipeline's own expressions (api/tv-webhook.js runPipeline) — exact equality only.
    const src = readFileSync(path.join(ROOT, "api", "tv-webhook.js"), "utf8");
    assert.match(src, /const isTrap = payload\.grade === "BEAR_TRAP_BUY" \|\| payload\.grade === "BULL_TRAP_SELL";/);
    assert.match(src, /const isSynergy = payload\.grade === "SYNERGY_BULL" \|\| payload\.grade === "SYNERGY_BEAR";/);
    const isTrap = c.grade === "BEAR_TRAP_BUY" || c.grade === "BULL_TRAP_SELL";
    const isSynergy = c.grade === "SYNERGY_BULL" || c.grade === "SYNERGY_BEAR";
    assert.equal(isTrap || isSynergy, false);
  }
  // Telegram formatter's exact matches likewise do not treat a candidate as a trap/synergy.
  const txt = webhook.formatTelegramAlert({ grade: "SYNERGY_BULL_CAND", decision: "EXECUTE_HIGH_CONVICTION_SYNERGY", direction: "LONG", chartMetrics: {}, liveOptionChainMetrics: {}, reasoning: "" });
  assert.doesNotMatch(txt, /SYNERGY EXECUTION/);
});

test("kill switch off: a candidate still never reaches the pipeline (no LOG_ONLY, no latest_signal)", hookCase({ env: { ...BRIDGE_ON, CANDIDATE_SHADOW_ENABLED: "false" }, snap: bullSnap() }, async ({ redis }) => {
  const res = await post(alert("BULL_TRAP_SELL_CAND", "SHORT"));
  assert.notEqual(res.body.decision, "LOG_ONLY");
  assert.equal(redis.store[LATEST], undefined);
}));

// ── Classification table ──

const fuse = (grade, dir, snap, extra = {}) => webhook.fuseChartWithOptionChain(alert(grade, dir, extra), snap, Date.now());
const classify = (real, dir, snap, { snapshotOk = true, extra = {} } = {}) => {
  const fused = fuse(real, dir, snap, extra);
  return { cat: cs.classifyCandidate({ realGrade: real, fused, snapshotOk }), fused };
};

test("classification: synergy (bull) — all four categories", () => {
  assert.equal(classify("SYNERGY_BULL", "LONG", bullSnap()).cat, "CONFIRMED");
  const mod = classify("SYNERGY_BULL", "LONG", bullSnap({ corridor: { deltaPCR: 1.1, floorStrike: 24500, roofStrike: 25400 } }));
  assert.equal(mod.fused.decision, "EXECUTE_MODERATE_SYNERGY");
  assert.equal(mod.cat, "UNCONFIRMED");
  // near the Call Roof: no longer downgraded to scalp (27-Nov-2026); a mixed ΔPCR stays MODERATE
  const nearRoof = classify("SYNERGY_BULL", "LONG", bullSnap({ corridor: { deltaPCR: 1.2, floorStrike: 24500, roofStrike: 25000 } }));
  assert.equal(nearRoof.fused.decision, "EXECUTE_MODERATE_SYNERGY");
  assert.equal(nearRoof.cat, "UNCONFIRMED");
  const veto = classify("SYNERGY_BULL", "LONG", bullSnap({ corridor: { deltaPCR: 0.8, floorStrike: 24500, roofStrike: 25400 } }));
  assert.equal(veto.fused.decision, "VETO_DIVERGENT_SYNERGY");
  assert.equal(veto.cat, "REJECTED");
  assert.equal(classify("SYNERGY_BULL", "LONG", bullSnap(), { snapshotOk: false }).cat, "UNVERIFIABLE", "stale");
  assert.equal(classify("SYNERGY_BULL", "LONG", null, { snapshotOk: false }).cat, "UNVERIFIABLE", "missing");
  assert.equal(classify("SYNERGY_BULL", "LONG", bullSnap({ corridor: { floorStrike: 24500, roofStrike: 25400 } })).cat, "UNVERIFIABLE", "no ΔPCR");
});

test("classification: synergy (bear) confirmed / rejected", () => {
  assert.equal(classify("SYNERGY_BEAR", "SHORT", bearSnap()).cat, "CONFIRMED");
  assert.equal(classify("SYNERGY_BEAR", "SHORT", bearSnap({ futures: { quadrant: "LONG_BUILDUP" } })).cat, "REJECTED");
});

test("classification: trap (bear trap buy) — all four categories", () => {
  assert.equal(classify("BEAR_TRAP_BUY", "LONG", bullSnap()).cat, "CONFIRMED", "put blitz + near floor");
  const far = classify("BEAR_TRAP_BUY", "LONG", bullSnap({ corridor: { deltaPCR: 1.4, floorStrike: 24600, roofStrike: 25400 } }));
  assert.equal(far.fused.decision, "EXECUTE_TIER1_SCOUT");
  assert.equal(far.cat, "UNCONFIRMED", "blitz but far from the floor");
  const noBlitz = classify("BEAR_TRAP_BUY", "LONG", bullSnap({ corridor: { deltaPCR: 1.0, floorStrike: 24900, roofStrike: 25400 } }));
  assert.equal(noBlitz.cat, "UNCONFIRMED", "near the floor but no put blitz");
  const veto = classify("BEAR_TRAP_BUY", "LONG", bearSnap({ corridor: { deltaPCR: 0.5, floorStrike: 24900, roofStrike: 25000 } }));
  assert.equal(veto.fused.decision, "VETO_SIGNAL");
  assert.equal(veto.cat, "REJECTED");
  assert.equal(classify("BEAR_TRAP_BUY", "LONG", bullSnap(), { snapshotOk: false }).cat, "UNVERIFIABLE", "stale");
  assert.equal(classify("BEAR_TRAP_BUY", "LONG", null, { snapshotOk: false }).cat, "UNVERIFIABLE", "missing");
  assert.equal(classify("BEAR_TRAP_BUY", "LONG", bullSnap({ corridor: { deltaPCR: "n/a", floorStrike: 24900 } })).cat, "UNVERIFIABLE", "non-numeric ΔPCR");
});

test("classification: trap (bull trap sell) confirmed / unconfirmed / rejected", () => {
  assert.equal(classify("BULL_TRAP_SELL", "SHORT", bearSnap()).cat, "CONFIRMED");
  assert.equal(classify("BULL_TRAP_SELL", "SHORT", bearSnap({ corridor: { deltaPCR: 0.9, floorStrike: 24500, roofStrike: 25000 } })).cat, "UNCONFIRMED");
  assert.equal(classify("BULL_TRAP_SELL", "SHORT", bullSnap({ corridor: { deltaPCR: 1.8, floorStrike: 24900, roofStrike: 25400 } })).cat, "REJECTED");
});

test("trap CONFIRMED matches exactly when today's code sizes the trap at 2 lots", () => {
  for (const [real, dir] of [["BEAR_TRAP_BUY", "LONG"], ["BULL_TRAP_SELL", "SHORT"]]) {
    for (const d of [0.5, 0.7, 0.75, 0.76, 1.0, 1.29, 1.3, 1.4]) {
      for (const wall of [24860, 24879, 24880, 24881, 24960, 25040, 25041, 25060]) {
        const corridor = dir === "LONG" ? { deltaPCR: d, floorStrike: wall, roofStrike: 25600 } : { deltaPCR: d, floorStrike: 24300, roofStrike: wall };
        const { cat, fused } = classify(real, dir, { snapshotAt: Date.now() - 10_000, corridor, futures: { quadrant: "NEUTRAL" } });
        if (fused.decision !== "EXECUTE_TIER1_SCOUT") continue;
        assert.equal(cat === "CONFIRMED", fused.recommendedLots === 2, `${real} ΔPCR ${d} wall ${wall}`);
      }
    }
  }
});

// ── Scorecard ──

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const sTick = (m, fut) => ({ minutes: m, time: hm(m), futPrice: fut, spot: fut - 40, futCombinedOI: 200000, putWriting: 300000, callWriting: 300000, isLiveTick: true });
const sPath = (pts) => {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, pa] = pts[i - 1];
    const [b, pb] = pts[i];
    for (let m = i === 1 ? a : a + 1; m <= b; m++) out.push(sTick(m, Math.round((pa + ((pb - pa) * (m - a)) / (b - a)) * 100) / 100));
  }
  return out;
};
const AT_1000_IST = Date.UTC(2026, 10, 13, 4, 30); // 13-Nov-2026 10:00 IST → minute 600
const bearRec = (o = {}) => ({ grade: "SYNERGY_BEAR_CAND", realGrade: "SYNERGY_BEAR", direction: "SHORT", entry: 24960, sl: 25000, t1: 24900, t2: 24840, category: "CONFIRMED", realDecision: "EXECUTE_HIGH_CONVICTION_SYNERGY", deltaPcr: 0.6, serverFutQuad: "SHORT_BUILDUP", chartFutQuad: "SHORT_BUILDUP", snapshotAgeSec: 20, ...o });

test("scorecard: CANDIDATE event shape", () => {
  const e = sc.buildCandidateEvent(bearRec(), AT_1000_IST);
  assert.equal(e.section, "CANDIDATE");
  assert.equal(e.type, "SYNERGY_BEAR_CAND");
  assert.equal(e.direction, "BEARISH");
  assert.equal(e.minutes, 600);
  assert.deepEqual(Object.keys(e.data).sort(), ["category", "chartFutQuad", "decision", "deltaPcr", "entry", "realGrade", "serverFutQuad", "sl", "snapshotAgeSec", "t1", "t2", "iv"].sort());
});

test("scorecard: CANDIDATE measured with the SIGNAL rule (hit and miss)", () => {
  const e = sc.buildCandidateEvent(bearRec(), AT_1000_IST);
  const sigShape = { ...e, section: "SIGNAL" };
  const fall = sc.compactSeries(sPath([[600, 25000], [640, 24900]])); // basis +40: t1 fut 24940, sl fut 25040
  const hit = sc.measureEvent(e, fall);
  assert.equal(hit.status, "MEASURED");
  assert.equal(hit.first, "T1");
  assert.equal(hit.hit, true);
  assert.deepEqual(hit, sc.measureEvent(sigShape, fall), "identical to the SIGNAL measurement");
  assert.deepEqual(hit, sc.measureSignal(e, fall));
  const rise = sc.compactSeries(sPath([[600, 25000], [640, 25100]]));
  const miss = sc.measureEvent(e, rise);
  assert.equal(miss.first, "STOP");
  assert.equal(miss.hit, false);
  assert.equal(sc.measureEvent(sc.buildCandidateEvent(bearRec({ sl: null }), AT_1000_IST), fall).status, "UNMEASURABLE");
  assert.match(sc.HIT_RULES.CANDIDATE, /Same rule as SIGNAL/);
});

test("scorecard: aggregate byCategory / byGrade, CSV rows; old documents aggregate", () => {
  const mk = (id, rec, hit) => {
    const ev = { ...sc.buildCandidateEvent(rec, AT_1000_IST), id };
    return { ev, out: hit === null ? { status: "UNMEASURABLE", reason: "signal has no T1 / stop levels" } : { status: "MEASURED", first: hit ? "T1" : "STOP", hit } };
  };
  const rows = [
    mk("c1", bearRec(), true),
    mk("c2", bearRec({ category: "UNCONFIRMED" }), false),
    mk("c3", bearRec({ grade: "BEAR_TRAP_BUY_CAND", realGrade: "BEAR_TRAP_BUY", direction: "LONG", category: "REJECTED" }), true),
    mk("c4", bearRec({ grade: "BULL_TRAP_SELL_CAND", category: "UNVERIFIABLE" }), null),
  ];
  const day = { date: "2026-11-13", events: rows.map((r) => r.ev), outcomes: Object.fromEntries(rows.map((r) => [r.ev.id, r.out])) };
  const agg = sc.aggregate([day], { minSample: 30 });
  const s = agg.sections.CANDIDATE;
  assert.equal(s.events, 4);
  assert.equal(s.measurable, 3);
  assert.equal(s.hits, 2);
  assert.deepEqual(Object.keys(s.byCategory), ["CONFIRMED", "UNCONFIRMED", "REJECTED", "UNVERIFIABLE"]);
  assert.equal(s.byCategory.CONFIRMED.hits, 1);
  assert.equal(s.byCategory.UNCONFIRMED.hits, 0);
  assert.equal(s.byCategory.UNCONFIRMED.measurable, 1);
  assert.equal(s.byCategory.REJECTED.hits, 1);
  assert.equal(s.byCategory.UNVERIFIABLE.excludedUnmeasurable, 1);
  assert.deepEqual(Object.keys(s.byGrade), ["SYNERGY_BULL_CAND", "SYNERGY_BEAR_CAND", "BEAR_TRAP_BUY_CAND", "BULL_TRAP_SELL_CAND"]);
  assert.equal(s.byGrade.SYNERGY_BEAR_CAND.events, 2);
  assert.equal(s.byGrade.BEAR_TRAP_BUY_CAND.hits, 1);
  assert.equal(s.byGrade.SYNERGY_BULL_CAND.events, 0);
  assert.equal(agg.sections.SIGNAL.events, 0, "candidates never count as real signals");
  const csv = sc.aggregateToCsv(agg);
  for (const k of Object.keys(s.byCategory)) assert.ok(csv.includes(`CANDIDATE,category:${k},`));
  for (const k of Object.keys(s.byGrade)) assert.ok(csv.includes(`CANDIDATE,grade:${k},`));
  // Old day documents (no CANDIDATE section, no data fields) aggregate without error.
  const old = sc.aggregate([{ date: "2026-10-01", events: [{ id: "x", section: "SIGNAL", type: "BULL_TRAP_SELL", minutes: 600, data: { category: "VETOED" } }], outcomes: {} }, { date: "2026-10-02" }]);
  assert.equal(old.sections.CANDIDATE.events, 0);
  assert.equal(old.sections.CANDIDATE.byCategory.CONFIRMED.events, 0);
  assert.equal(old.sections.SIGNAL.events, 1);
  // Day CSV carries candidate rows. The daily Telegram's other sections are unchanged by candidates:
  // with the candidate block switched off the text is identical; on, only the "Candidates" block is added.
  assert.ok(sc.dayToCsv(day).includes("CANDIDATE"));
  const base = { date: "2026-11-13", dataQuality: { state: "OK", coveragePct: 100 }, events: [], outcomes: {} };
  const withCand = { ...base, events: day.events, outcomes: day.outcomes };
  assert.equal(sc.formatDailyTelegram(withCand, { candidates: false }), sc.formatDailyTelegram(base));
  assert.ok(sc.formatDailyTelegram(withCand).startsWith(`${sc.formatDailyTelegram(base)}\n• *Candidates*`));
});

test("settings snapshot whitelists CANDIDATE_SHADOW_ENABLED", () => {
  assert.equal(sc.settingsSnapshot({ env: { CANDIDATE_SHADOW_ENABLED: "false" } }).envOverrides.CANDIDATE_SHADOW_ENABLED, "false");
});

// ── GET ──

test("GET /api/tv-webhook returns today's candidates newest first; existing fields unchanged", hookCase({ snap: bearSnap() }, async () => {
  await post(alert("SYNERGY_BEAR_CAND", "SHORT"));
  await post(alert("BULL_TRAP_SELL_CAND", "SHORT"));
  const res = await get();
  assert.equal(res.statusCode, 200);
  for (const k of ["lastResult", "success", "connected", "istDate", "activeTrade", "openCarry", "latestSignal", "signals"]) assert.ok(k in res.body, k);
  assert.equal(res.body.latestSignal, null);
  assert.deepEqual(res.body.signals, []);
  assert.deepEqual(res.body.candidates.map((c) => c.grade), ["BULL_TRAP_SELL_CAND", "SYNERGY_BEAR_CAND"]);
}));

// ── Pine (text level) ──

test("Pine v4.3.1: each candidate grade appears once, in an alert() guarded by whSendCandidates", () => {
  const src = readFileSync(path.join(ROOT, "strategy_dashboard_v4_3_1_candidates.pine"), "utf8").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  for (const c of CASES) {
    const hits = lines.map((l, i) => [l, i]).filter(([l]) => l.includes(`"${c.grade}"`));
    assert.equal(hits.length, 1, c.grade);
    const [line, i] = hits[0];
    assert.match(line, new RegExp(`^\\s+alert\\(f_json\\("${c.grade}", "${c.dir}", `));
    assert.match(line, /alert\.freq_once_per_bar_close\)$/);
    assert.match(lines[i - 1], /^if whSendCandidates and \w+CandSig$/);
  }
  assert.match(src, /^whSendCandidates = input\.bool\(true, "Send shadow candidate alerts \(no orders\)"/m);
  assert.match(src, /^candCooldownBars = input\.int\(4,/m);
  // Real alerts are still present, unchanged.
  for (const g of ["SYNERGY_BULL", "SYNERGY_BEAR", "BEAR_TRAP_BUY", "BULL_TRAP_SELL"]) assert.equal(lines.filter((l) => l.includes(`f_json("${g}",`)).length, 1, g);
});

test("Pine: the original v4.3 file is unchanged", (t) => {
  const file = readFileSync(path.join(ROOT, "strategy_dashboard_v4_3_real_oi.pine"), "utf8").replace(/\r\n/g, "\n");
  let head;
  try {
    head = execFileSync("git", ["show", "HEAD:strategy_dashboard_v4_3_real_oi.pine"], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).replace(/\r\n/g, "\n");
  } catch (e) {
    t.skip("git not available");
    return;
  }
  assert.equal(file, head);
  assert.doesNotMatch(file, /_CAND/);
});
