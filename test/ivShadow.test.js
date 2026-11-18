/**
 * IV shadow (src/ivShadow.js): ATM implied volatility recorded on signals and candidates, and
 * scorecard hit rates by LOW / MID / HIGH IV. Measurement only — decisions must be identical with
 * any IV, or none. All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_MAX_AGE_SEC", "FLOW_BRIDGE_ENABLED", "FLOW_BRIDGE_URL",
  "FLOW_BRIDGE_SECRET", "FLOW_BRIDGE_DECISIONS", "CANDIDATE_SHADOW_ENABLED", "CANDIDATE_TELEGRAM_ENABLED",
  "SCORECARD_ENABLED", "TV_ACK_DEADLINE_MS",
]) delete process.env[k];

const iv = await import("../src/ivShadow.js");
const webhook = await import("../api/tv-webhook.js");
const sc = await import("../src/scorecard.js");
const cs = await import("../src/candidateShadow.js");

// ── Pure helpers ──

const row = (strikePrice, ceIv, peIv, ceLtp = 100, peLtp = 100) => ({ strikePrice, CE: { impliedVolatility: ceIv, lastPrice: ceLtp }, PE: { impliedVolatility: peIv, lastPrice: peLtp } });

test("summariseAtmIv: nearest strike with both IVs; skew = put − call; mean = ATM IV", () => {
  const rows = [row(25350, 11.0, 12.0), row(25400, 11.6, 13.0, 397, 380), row(25450, 11.2, 13.4)];
  assert.deepEqual(iv.summariseAtmIv(rows, 25404.65, { expiry: "29-Dec-2026" }), { strike: 25400, ceIv: 11.6, peIv: 13, atmIv: 12.3, skew: 1.4, ceLtp: 397, peLtp: 380, expiry: "29-Dec-2026" });
});

test("summariseAtmIv: skips strikes with an unquoted leg (IV 0 / missing), ties go to the lower strike", () => {
  const rows = [row(25400, 0, 13.0), row(25350, 11.0, 12.0), row(25450, 11.2, 13.4)];
  assert.equal(iv.summariseAtmIv(rows, 25400).strike, 25350, "25400 has no call IV; 25350 and 25450 tie → lower");
  assert.equal(iv.summariseAtmIv([row(25400, null, 12)], 25400), null);
  assert.equal(iv.summariseAtmIv([], 25400), null);
  assert.equal(iv.summariseAtmIv(rows, 0), null);
  assert.equal(iv.summariseAtmIv(null, 25400), null);
  assert.equal(iv.summariseAtmIv([{ strikePrice: "x" }, null], 25400), null, "never throws");
});

test("ivShadowFromSnapshot: compact fields, or null without a usable ivAtm", () => {
  assert.deepEqual(iv.ivShadowFromSnapshot({ ivAtm: { strike: 25400, ceIv: 11.6, peIv: 13, atmIv: 12.3, skew: 1.4, ceLtp: 1, expiry: "E" } }), { atmIv: 12.3, ceIv: 11.6, peIv: 13, skew: 1.4, strike: 25400, expiry: "E" });
  for (const s of [null, {}, { ivAtm: null }, { ivAtm: { atmIv: 0 } }, { ivAtm: { atmIv: "abc" } }]) assert.equal(iv.ivShadowFromSnapshot(s), null);
});

test("ivCuts / ivBandOf: terciles of the sample; UNKNOWN below 3 readings or without IV", () => {
  assert.equal(iv.ivCuts([10, 12]), null);
  const cuts = iv.ivCuts([10, 11, 12, 13, 14, 15, 16, null, 0]);
  assert.deepEqual(cuts, { lo: 12, hi: 14, n: 7 });
  assert.equal(iv.ivBandOf(10, cuts), "LOW");
  assert.equal(iv.ivBandOf(12, cuts), "LOW");
  assert.equal(iv.ivBandOf(13, cuts), "MID");
  assert.equal(iv.ivBandOf(14, cuts), "MID");
  assert.equal(iv.ivBandOf(14.01, cuts), "HIGH");
  assert.equal(iv.ivBandOf(null, cuts), "UNKNOWN");
  assert.equal(iv.ivBandOf(12, null), "UNKNOWN");
});

// ── Webhook: recorded, never decisive ──

const SECRET = "iv-test-secret";
const tick = () => new Promise((r) => setImmediate(r));
function createFakeRedis(initial = {}) {
  const store = { ...initial };
  const lists = {};
  return {
    store, lists,
    async get(k) { await tick(); return store[k] ?? null; },
    async set(k, v, opts = {}) { await tick(); if (opts.nx && k in store) return null; store[k] = v; return "OK"; },
    async del(k) { if (k in store) { delete store[k]; return 1; } return 0; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim(k, a, b) { lists[k] = (lists[k] || []).slice(a, b + 1); return "OK"; },
    async lrange(k, a = 0, b = -1) { const l = lists[k] || []; return b === -1 ? l.slice(a) : l.slice(a, b + 1); },
    async expire() { return 1; },
  };
}
const snap = (ivAtm) => ({ snapshotAt: Date.now() - 20_000, snapshotSource: "poller", corridor: { deltaPCR: 1.4, floorStrike: 24900, roofStrike: 25400 }, futures: { quadrant: "LONG_BUILDUP" }, smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" }, ...(ivAtm === undefined ? {} : { ivAtm }) });
const alert = (grade) => ({ secret: SECRET, sym: "NSE:NIFTY", tf: "15", dir: "LONG", grade, close: 24960, sl: 24895, cappedSl: 24895, rDist: 65, t1Dist: 65, t2Dist: 130, futQuad: "LONG_BUILDUP" });

async function runOnce(ivAtm, grade) {
  const env = { TV_WEBHOOK_SECRET: SECRET, FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://algo.example.test/flow", FLOW_BRIDGE_SECRET: "iv-hmac" };
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  const redis = createFakeRedis({ "nifty:flow:latest": JSON.stringify(snap(ivAtm)) });
  const bridge = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  webhook.setRedisClientForTesting(redis);
  webhook.setWebhookDepsForTesting({
    now: () => Date.now(), isLiveMarket: async () => true,
    refresh: async () => ({ ok: false, stage: "nse", error: "none" }),
    sendText: async () => true,
    bridgeFetch: async (url, init) => { bridge.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: "accepted", reason: null, mode: "dry_run", orderRef: "R" }), { status: 200 }); },
    newTradeId: () => "ft-iv-1",
  });
  try {
    const req = { method: "POST", body: JSON.stringify(alert(grade)), query: {}, headers: {} };
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } };
    await webhook.default(req, res);
    const events = Object.entries(redis.lists).filter(([k]) => k.startsWith("nifty:sc:events:")).flatMap(([, l]) => l.map((x) => (typeof x === "string" ? JSON.parse(x) : x)));
    const cands = (redis.lists[cs.candidateListKey(webhook.getIstDateString())] || []).map((x) => JSON.parse(x));
    return { res, bridge, events, cands, active: redis.store["nifty:tv:active_trade"] ? JSON.parse(redis.store["nifty:tv:active_trade"]) : null };
  } finally {
    globalThis.fetch = origFetch;
    webhook.setRedisClientForTesting(null);
    webhook.setWebhookDepsForTesting(null);
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const IV_HIGH = { strike: 24950, ceIv: 31.5, peIv: 34.0, atmIv: 32.75, skew: 2.5, ceLtp: 700, peLtp: 690, expiry: "24-Nov-2026" };
const IV_LOW = { strike: 24950, ceIv: 9.1, peIv: 10.0, atmIv: 9.55, skew: 0.9, ceLtp: 150, peLtp: 140, expiry: "24-Nov-2026" };

test("real signal: IV recorded on the verdict and its scorecard event; decision, order and lock identical for any IV or none", async () => {
  const summary = (o) => ({ decision: o.res.body.decision, lots: o.res.body.recommendedLots, reasoning: o.res.body.fusedVerdict.reasoning, orders: o.bridge.map(({ id, ts, ...b }) => b), lock: o.active && { grade: o.active.grade, direction: o.active.direction, entryPrice: o.active.entryPrice, stopLoss: o.active.stopLoss } });
  const none = await runOnce(undefined, "SYNERGY_BULL");
  const high = await runOnce(IV_HIGH, "SYNERGY_BULL");
  const low = await runOnce(IV_LOW, "SYNERGY_BULL");
  assert.equal(none.res.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(none.bridge.length, 1);
  assert.deepEqual(summary(high), summary(none));
  assert.deepEqual(summary(low), summary(none));
  assert.equal(none.res.body.fusedVerdict.ivShadow, null);
  assert.deepEqual(high.res.body.fusedVerdict.ivShadow, { atmIv: 32.75, ceIv: 31.5, peIv: 34, skew: 2.5, strike: 24950, expiry: "24-Nov-2026" });
  assert.equal(high.bridge[0].iv, undefined, "nothing IV-related is sent to the Algo");
  const ev = high.events.find((e) => e.section === "SIGNAL");
  assert.equal(ev.data.iv.atmIv, 32.75);
  assert.equal(none.events.find((e) => e.section === "SIGNAL").data.iv, null);
});

test("candidate: IV recorded on the record and its scorecard event; category unchanged", async () => {
  const none = await runOnce(undefined, "SYNERGY_BULL_CAND");
  const high = await runOnce(IV_HIGH, "SYNERGY_BULL_CAND");
  assert.equal(high.res.body.category, none.res.body.category);
  assert.equal(high.bridge.length + none.bridge.length, 0);
  assert.equal(high.cands[0].iv.atmIv, 32.75);
  assert.equal(none.cands[0].iv, null);
  assert.equal(high.events.find((e) => e.section === "CANDIDATE").data.iv.skew, 2.5);
});

// ── Scorecard ──

function sigEvent(minutes, atmIv, hit) {
  const t = Date.parse("2026-11-13T03:45:00Z") + (minutes - 555) * 60000;
  const ev = sc.buildSignalEvent({ grade: "SYNERGY_BULL", decision: "EXECUTE_HIGH_CONVICTION_SYNERGY", direction: "LONG", entryPrice: 25000, stopLoss: 24950, target1Price: 25080, target2Price: 25160, ivShadow: atmIv === null ? null : { atmIv } }, t);
  return { ev, out: { status: "MEASURED", first: hit ? "T1" : "STOP", hit } };
}
function candEvent(minutes, atmIv, hit) {
  const t = Date.parse("2026-11-13T03:45:00Z") + (minutes - 555) * 60000;
  const ev = sc.buildCandidateEvent({ grade: "SYNERGY_BULL_CAND", realGrade: "SYNERGY_BULL", direction: "LONG", entry: 25000, sl: 24950, t1: 25080, t2: 25160, category: "CONFIRMED", iv: atmIv === null ? null : { atmIv } }, t);
  return { ev, out: { status: "MEASURED", first: hit ? "T1" : "STOP", hit } };
}

test("aggregate: SIGNAL and CANDIDATE split by one shared set of IV terciles; missing IV → UNKNOWN; CSV rows", () => {
  const items = [
    sigEvent(600, 10, true), sigEvent(610, 11, true), sigEvent(620, 13, false), sigEvent(630, 14, true), sigEvent(640, 16, false), sigEvent(650, 17, false),
    sigEvent(660, null, true),
    candEvent(700, 12, true), candEvent(710, 15, false), candEvent(720, null, false),
  ];
  const doc = { date: "2026-11-13", events: items.map((x) => x.ev), outcomes: Object.fromEntries(items.map((x) => [x.ev.id, x.out])) };
  const agg = sc.aggregate([doc], { minSample: 2 });
  assert.deepEqual(agg.ivBands, { lo: 12.33, hi: 14.67, n: 8 });
  const s = agg.sections.SIGNAL.byIv;
  assert.deepEqual([s.LOW.events, s.MID.events, s.HIGH.events, s.UNKNOWN.events], [2, 2, 2, 1]);
  assert.deepEqual([s.LOW.hits, s.MID.hits, s.HIGH.hits], [2, 1, 0]);
  const c = agg.sections.CANDIDATE.byIv;
  assert.deepEqual([c.LOW.events, c.MID.events, c.HIGH.events, c.UNKNOWN.events], [1, 0, 1, 1]);
  assert.equal(agg.sections.SIGNAL.events, 7, "totals unchanged by the split");
  assert.equal(agg.sections.FUSION.byIv, undefined, "only SIGNAL and CANDIDATE are split");
  const csv = sc.aggregateToCsv(agg);
  for (const b of ["LOW", "MID", "HIGH", "UNKNOWN"]) {
    assert.ok(csv.includes(`SIGNAL,iv:${b},`));
    assert.ok(csv.includes(`CANDIDATE,iv:${b},`));
  }
});

test("aggregate: old documents without IV aggregate as before, all UNKNOWN, no cut-offs", () => {
  const old = sc.aggregate([{ date: "2026-10-01", events: [{ id: "x", section: "SIGNAL", type: "BULL_TRAP_SELL", minutes: 600, data: { category: "VETOED" } }], outcomes: {} }, { date: "2026-10-02" }]);
  assert.equal(old.ivBands, null);
  assert.equal(old.sections.SIGNAL.byIv.UNKNOWN.events, 1);
  assert.equal(old.sections.SIGNAL.events, 1);
});

test("daily scorecard Telegram is unchanged by IV fields", () => {
  const a = sigEvent(600, 32, true);
  const b = { ...a.ev, data: { ...a.ev.data, iv: null } };
  const doc = (ev) => ({ date: "2026-11-13", dataQuality: { state: "OK", coveragePct: 100 }, events: [ev], outcomes: { [ev.id]: a.out } });
  assert.equal(sc.formatDailyTelegram(doc(a.ev)), sc.formatDailyTelegram(doc(b)));
});
