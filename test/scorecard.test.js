/**
 * Daily scorecard (measurement only): capture, outcomes, finalisation, aggregates, API views,
 * backfill, storage bound, and proof that decisions are unchanged. All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SCORECARD_ENABLED", "SCORECARD_BAND_PCT", "FLOW_BRIDGE_ENABLED",
]) delete process.env[k];

const sc = await import("../src/scorecard.js");
const { createScorecardHandler } = await import("../api/scorecard.js");
const { calculateEODDecision, buildScorecardReading } = await import("../api/nifty-oi.js");
const webhook = await import("../api/tv-webhook.js");
const { buildBackfill } = await import("../scripts/backfill-scorecard.mjs");

const SECRET = "sc-test-secret";
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const tick = (m, fut, extra = {}) => ({ minutes: m, time: hm(m), futPrice: fut, spot: fut - 40, futCombinedOI: 200000, putWriting: 300000, callWriting: 300000, netDiff: 0, isLiveTick: true, ...extra });
const path = (pts) => { // pts: [[minute, price], …] → one tick per minute, linear between points
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, pa] = pts[i - 1];
    const [b, pb] = pts[i];
    for (let m = i === 1 ? a : a + 1; m <= b; m++) out.push(tick(m, Math.round((pa + ((pb - pa) * (m - a)) / (b - a)) * 100) / 100));
  }
  return out;
};
const ev = (o) => ({ id: `E:${o.minutes}:${o.section}:${o.type || "X"}`, t: 0, time: hm(o.minutes), section: "TURN", type: "EARLY", data: {}, dq: { ok: true }, ...o });

function fakeStore() {
  const kv = {};
  const lists = {};
  const tick = () => new Promise((r) => setImmediate(r));
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    kv, lists,
    get: async (k) => { await tick(); return k in kv ? clone(kv[k]) : null; },
    set: async (k, v) => { await tick(); kv[k] = clone(v); return "OK"; },
    setNx: async (k, v) => { await tick(); if (k in kv) return false; kv[k] = clone(v); return true; },
    del: async (k) => { delete kv[k]; delete lists[k]; return 1; },
    rpush: async (k, v) => { (lists[k] ||= []).push(clone(v)); return lists[k].length; },
    ltrim: async (k, a, b) => { lists[k] = (lists[k] || []).slice(a, b + 1); return "OK"; },
    lrange: async (k) => clone(lists[k] || []),
    expire: async () => 1,
    incr: async (k, by = 1) => { kv[k] = (Number(kv[k]) || 0) + by; return kv[k]; },
    mget: async (ks) => ks.map((k) => (k in kv ? clone(kv[k]) : null)),
  };
}

// ── capture ──

const reading = (m, o = {}) => ({ t: m * 60000, minutes: m, futPrice: 25000, spot: 24960, dq: { state: "OK", coveragePct: 100 }, fusion: { quadrant: "LONG_BUILDUP", scenario: "MIXED_FLOW" }, turn: null, radar: null, eod: null, ...o });

test("capture: fusion quadrant and scenario changes (not the first reading)", () => {
  let r = sc.captureEvents(null, reading(600));
  assert.equal(r.events.length, 0);
  r = sc.captureEvents(r.state, reading(601, { fusion: { quadrant: "SHORT_BUILDUP", scenario: "BULL_TRAP" } }));
  assert.deepEqual(r.events.map((e) => [e.section, e.type, e.direction]), [["FUSION", "QUADRANT_CHANGE", "BEARISH"], ["FUSION", "SCENARIO_CHANGE", "BEARISH"]]);
  assert.deepEqual(r.events[0].data, { from: "LONG_BUILDUP", to: "SHORT_BUILDUP" });
  assert.equal(r.events[0].dq.state, "OK");
  assert.equal(sc.captureEvents(r.state, reading(602, { fusion: { quadrant: "SHORT_BUILDUP", scenario: "BULL_TRAP" } })).events.length, 0);
});

const turn = (stage, extremeMin, extra = {}) => ({ status: "OK", stage, direction: "BEARISH", reference: { kind: "high", time: hm(extremeMin), minutes: extremeMin, price: 25100 }, futuresLeg: { movePts: -50, movePct: -0.2, oiChange: 500, oiPct: 0.25, quadrant: "SHORT_BUILDUP" }, optionsLeg: { putLegDelta: 0, callLegDelta: 45000, netDelta: -45000, driver: "WRITING", dominantLeg: "CALL", deltaPcrAtExtreme: 1, deltaPcrNow: 0.87 }, elapsedMin: 20, coverage: { ok: true, coveragePct: 100 }, ...extra });

test("capture: Turn Tracker stage transitions once per extreme, with both legs", () => {
  let r = sc.captureEvents(null, reading(610, { turn: turn("EARLY", 600) }));
  assert.equal(r.events[0].type, "EARLY");
  assert.equal(r.events[0].data.options.callLegDelta, 45000);
  assert.equal(r.events[0].data.futures.oiPct, 0.25);
  r = sc.captureEvents(r.state, reading(611, { turn: turn("EARLY", 600) }));
  assert.equal(r.events.length, 0, "same stage, same extreme: nothing");
  r = sc.captureEvents(r.state, reading(620, { turn: turn("CONFIRMED", 600) }));
  assert.equal(r.events[0].type, "CONFIRMED");
  r = sc.captureEvents(r.state, reading(625, { turn: turn("LIKELY_TURN", 600) }));
  assert.equal(r.events.length, 0, "a lower stage later is not a transition");
  r = sc.captureEvents(r.state, reading(640, { turn: turn("EARLY", 630) }));
  assert.equal(r.events.length, 1, "new extreme → new event");
  assert.equal(sc.captureEvents(null, reading(610, { turn: { status: "INSUFFICIENT_DATA", stage: null } })).events.length, 0);
});

test("capture: radar trap and divergence once per declared turn; EOD slot, flip and final", () => {
  const trap = (window) => ({ isTriggered: true, type: "BULL_TRAP_REVERSAL", direction: "BEARISH_TURN", window, totalPriceDelta: 30, flow: { netDelta: -40000, putLegDelta: 0, callLegDelta: 40000, driver: "WRITING" } });
  let r = sc.captureEvents(null, reading(780, { radar: trap("12:30-13:00") }));
  assert.deepEqual(r.events.map((e) => [e.section, e.type, e.direction]), [["RADAR", "BULL_TRAP_REVERSAL", "BEARISH"]]);
  r = sc.captureEvents(r.state, reading(781, { radar: trap("12:30-13:01") }));
  assert.equal(r.events.length, 0, "the same trap with a growing C2 window is one event");
  r = sc.captureEvents(r.state, reading(790, { radar: { isTriggered: false, type: "UNWINDING_DIVERGENCE", direction: "BULLISH_LEAN", window: "12:45-13:10", flow: {} } }));
  assert.deepEqual([r.events[0].type, r.events[0].direction], ["DIVERGENCE", "BULLISH"]);

  const eod = (slot, category) => ({ verdict: category, bias: category === "STBT" ? "BEARISH" : "NEUTRAL", score: category === "STBT" ? -3 : 0, groups: { A: -1, B: -2, C: 0 }, unverifiedGroups: [], slot, category, stopLoss: 25100 });
  let s = sc.captureEvents(null, reading(855, { eod: eod(855, "NO_CARRY") }));
  assert.deepEqual(s.events.map((e) => [e.section, e.type]), [["EOD_SLOT", "SLOT"]]);
  s = sc.captureEvents(s.state, reading(857, { eod: eod(855, "STBT") }));
  assert.deepEqual(s.events.map((e) => [e.type, e.direction, e.data.from]), [["FLIP", "BEARISH", "NO_CARRY"]]);
  s = sc.captureEvents(s.state, reading(938, { futPrice: 24990, eod: eod(935, "STBT") }));
  s = sc.captureEvents(s.state, reading(940, { futPrice: 24980, eod: eod(935, "STBT") }));
  const fin = sc.finalEodEvent(s.state);
  assert.equal(fin.minutes, 938, "final = last reading at or before 15:38");
  assert.equal(fin.futPrice, 24990);
  assert.equal(fin.direction, "BEARISH");
});

test("capture: signal categories and trade events", () => {
  const base = { grade: "BULL_TRAP_SELL", direction: "SHORT", entryPrice: 25000, stopLoss: 25070, target1Price: 24930, target2Price: 24860, reasoning: "r" };
  const at = Date.UTC(2026, 10, 12, 4, 50); // 10:20 IST
  assert.equal(sc.buildSignalEvent({ ...base, decision: "EXECUTE_TIER1_SCOUT" }, at).data.category, "APPROVED");
  assert.equal(sc.buildSignalEvent({ ...base, decision: "EXECUTE_TIER1_SCOUT", execution: { status: "NOT_EXECUTED", reason: "margin" } }, at).data.category, "NOT_EXECUTED");
  const v = sc.buildSignalEvent({ ...base, decision: "VETO_SIGNAL", reasoning: "VETOED: put writing" }, at);
  assert.deepEqual([v.data.category, v.data.reason, v.time, v.direction], ["VETOED", "VETOED: put writing", "10:20", "BEARISH"]);
  const t = sc.buildTradeEvent({ kind: "FLOW", tradeId: "ft-1", exitGrade: "TARGET_2_HIT", direction: "SHORT", entry: 25000, exitPrice: 24860, pnlInr: 1070, pnlKnown: true, nowMs: at });
  assert.deepEqual(sc.measureEvent(t, null), { status: "MEASURED", pnlInr: 1070, hit: true });
  assert.equal(sc.measureEvent({ ...t, data: { ...t.data, pnlKnown: false } }, null).status, "UNMEASURABLE");
});

test("capture never mutates the reading (frozen inputs)", () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === "object" && deepFreeze(v)); return Object.freeze(o); };
  const r = deepFreeze(reading(610, { turn: turn("EARLY", 600), radar: { isTriggered: true, type: "BEAR_TRAP_REVERSAL", direction: "BULLISH_TURN", window: "10:00-10:10", flow: {} } }));
  const prev = deepFreeze({ fusionQuadrant: "SHORT_BUILDUP", fusionScenario: "MIXED_FLOW", turn: {}, radarKeys: [], eod: { lastSlot: null, lastCategory: null, last: null } });
  assert.doesNotThrow(() => sc.captureEvents(prev, r));
});

// ── outcomes ──

test("directional outcome: horizons, excursions and band-first (favourable)", () => {
  const series = sc.compactSeries(path([[600, 25000], [620, 25100], [660, 25050], [938, 25200]]));
  const o = sc.measureDirectional(ev({ minutes: 600, direction: "BULLISH", futPrice: 25000 }), series, { bandPct: 0.2 });
  assert.equal(o.status, "MEASURED");
  assert.equal(o.horizons[15].pts, 75);
  assert.equal(o.horizons[30].pts, 87.5);
  assert.equal(o.horizons[60].pts, 50);
  assert.equal(o.horizons.close.pts, 200);
  assert.equal(o.excursion60.mfePts, 100);
  assert.equal(o.excursion60.maePts, 0);
  assert.deepEqual([o.band60.first, o.band60.at], ["FAVOURABLE", "10:10"], "+50 pts (0.20% of 25000) first reached at 10:10");
  assert.equal(o.hit, true);
});

test("directional outcome: adverse first, neither, gap, close-truncated, after-close horizons", () => {
  const down = sc.compactSeries(path([[600, 25000], [630, 24940], [700, 25100]]));
  const a = sc.measureDirectional(ev({ minutes: 600, direction: "BULLISH", futPrice: 25000 }), down);
  assert.deepEqual([a.band60.first, a.hit], ["ADVERSE", false]);
  const flat = sc.compactSeries(path([[600, 25000], [700, 25020]]));
  const n = sc.measureDirectional(ev({ minutes: 600, direction: "BEARISH", futPrice: 25000 }), flat);
  assert.deepEqual([n.band60.first, n.hit], ["NEITHER", false]);
  const holed = sc.compactSeries(path([[600, 25000], [700, 25010]]).filter((t) => t.minutes < 610 || t.minutes > 625));
  const g = sc.measureDirectional(ev({ minutes: 600, direction: "BULLISH", futPrice: 25000 }), holed);
  assert.equal(g.status, "UNMEASURABLE");
  assert.match(g.reason, /not enough data for 60-min window 10:00–11:00 \(\d+ of 61 expected ticks; gap 10:09–10:26\)/);
  assert.equal(g.horizons[15].status, "UNMEASURABLE");
  const late = sc.compactSeries(path([[900, 25000], [940, 25010]]));
  const l = sc.measureDirectional(ev({ minutes: 900, direction: "BULLISH", futPrice: 25000 }), late);
  assert.equal(l.status, "UNMEASURABLE");
  assert.match(l.reason, /cut by the 15:38 close/);
  assert.equal(l.horizons[60].status, "AFTER_CLOSE");
  assert.equal(l.horizons[30].status, "OK");
});

test("signal outcome: T1 first, stop first, neither — vetoed signals measured the same way", () => {
  const mk = (category) => ({ ...ev({ minutes: 600, section: "SIGNAL", direction: "BEARISH" }), data: { category, entry: 24960, sl: 25000, t1: 24900 } });
  const fall = sc.compactSeries(path([[600, 25000], [640, 24900]])); // basis +40: t1 fut 24940, sl fut 25040
  const a = sc.measureSignal(mk("APPROVED"), fall);
  assert.deepEqual([a.first, a.hit, a.t1Fut, a.slFut], ["T1", true, 24940, 25040]);
  const v = sc.measureSignal(mk("VETOED"), fall);
  assert.equal(v.hit, true, "the veto blocked a winner (counterfactual)");
  const rise = sc.compactSeries(path([[600, 25000], [640, 25100]]));
  assert.equal(sc.measureSignal(mk("APPROVED"), rise).first, "STOP");
  const flat = sc.compactSeries(path([[600, 25000], [938, 25010]]));
  assert.deepEqual([sc.measureSignal(mk("APPROVED"), flat).first, sc.measureSignal(mk("APPROVED"), flat).hit], ["NEITHER", false]);
  assert.equal(sc.measureSignal({ ...mk("APPROVED"), data: { category: "APPROVED" } }, flat).status, "UNMEASURABLE");
});

// ── finalisation, pending EOD across a weekend ──

test("finalise is idempotent (and concurrent-safe); EOD outcome completes on Monday 09:20 with one morning message", async () => {
  const store = fakeStore();
  const sent = [];
  const fri = "2026-11-13";
  let s = sc.captureEvents(null, reading(900, { futPrice: 25000, futuresExpiry: "24-Nov-2026", eod: { verdict: "BTST", bias: "BULLISH", score: 3, groups: { A: 1, B: 2, C: 0 }, unverifiedGroups: [], slot: 900, category: "BTST", stopLoss: 24900 } }));
  s = sc.captureEvents(s.state, reading(938, { futPrice: 25000, futuresExpiry: "24-Nov-2026", eod: { verdict: "BTST", bias: "BULLISH", score: 3, groups: { A: 1, B: 2, C: 0 }, unverifiedGroups: [], slot: 935, category: "BTST", stopLoss: 24900 } }));
  store.kv[sc.keys.state(fri)] = s.state;
  store.lists[sc.keys.events(fri)] = s.events;
  const deps = { getTimeline: async () => path([[555, 24950], [938, 25000]]), settings: { x: 1 }, send: async (t) => { sent.push(t); return true; }, now: () => 0 };
  const [r1, r2] = await Promise.all([sc.finaliseDay({ store, date: fri, deps }), sc.finaliseDay({ store, date: fri, deps })]);
  assert.deepEqual([r1.status, r2.status].sort(), ["FINALISED", "IN_PROGRESS"]);
  assert.equal((await sc.finaliseDay({ store, date: fri, deps })).status, "ALREADY_FINAL");
  assert.equal(sent.length, 1, "one daily scorecard message");
  assert.match(sent[0], /Scorecard 2026-11-13/);
  assert.equal(store.kv[sc.keys.day(fri)].eodOutcome.status, "PENDING");

  // Saturday/Sunday: nothing. Monday before 09:20: not yet. Monday 09:20: completed once.
  const mon = "2026-11-16";
  const monday = path([[555, 25060], [570, 25080]]);
  assert.equal((await sc.completePendingEod({ store, today: mon, timeline: monday, nowMins: 558 })).status, "NOT_YET");
  const c = await sc.completePendingEod({ store, today: mon, timeline: monday, nowMins: 561, futuresExpiry: "24-Nov-2026", send: async (t) => { sent.push(t); return true; } });
  assert.equal(c.status, "COMPLETED");
  assert.deepEqual([c.outcome.openPrice, c.outcome.price0920, c.outcome.hit], [25060, 25066.67, true]);
  assert.equal(store.kv[sc.keys.day(fri)].eodOutcome.status, "MEASURED");
  assert.match(sent[1], /EOD outcome 2026-11-13:\* BTST .* HIT \(2026-11-16\)/);
  assert.equal((await sc.completePendingEod({ store, today: mon, timeline: monday, nowMins: 600 })).status, "NOTHING_PENDING");
});

test("EOD next-session outcome: contract roll and a gap at the open are unmeasurable; NO CARRY rule", () => {
  const final = { futPrice: 25000, futuresExpiry: "24-Nov-2026", data: { category: "STBT" } };
  const next = sc.compactSeries(path([[555, 24950], [570, 24940]]));
  assert.equal(sc.measureEodNext(final, next, { nextFuturesExpiry: "29-Dec-2026" }).status, "UNMEASURABLE");
  const gappy = sc.compactSeries(path([[555, 24950], [570, 24940]]).filter((t) => t.minutes !== 556 && t.minutes !== 557 && t.minutes !== 558 && t.minutes !== 559));
  assert.equal(sc.measureEodNext(final, gappy).status, "UNMEASURABLE");
  const stbt = sc.measureEodNext(final, next);
  assert.deepEqual([stbt.hit, stbt.signedMove0920Pts], [true, 53.33]);
  const nc = sc.measureEodNext({ futPrice: 25000, data: { category: "NO_CARRY" } }, next);
  assert.equal(nc.hit, true, "|−0.19%| < 0.35%");
});

// ── aggregates ──

test("Wilson interval and aggregates exclude unmeasurable events and say how many", () => {
  assert.deepEqual(sc.wilson(8, 10), { lo: 0.49, hi: 0.943 });
  assert.deepEqual(sc.wilson(0, 0), { lo: null, hi: null });
  const m = (hit, h60) => ({ status: "MEASURED", hit, horizons: { 60: { status: "OK", pts: h60 } }, excursion60: { status: "OK", mfePts: 60, maePts: -20 } });
  const days = [
    { date: "d1", events: [ev({ minutes: 600, type: "EARLY" }), ev({ minutes: 601, type: "CONFIRMED" }), ev({ minutes: 602, type: "EARLY" })], outcomes: {} },
    { date: "d2", backfilled: true, events: [ev({ minutes: 600, section: "SIGNAL", type: "BULL_TRAP_SELL", data: { category: "VETOED" } })], outcomes: {} },
  ];
  days[0].outcomes[days[0].events[0].id] = m(true, 40);
  days[0].outcomes[days[0].events[1].id] = m(false, -10);
  days[0].outcomes[days[0].events[2].id] = { status: "UNMEASURABLE", reason: "gap" };
  days[1].outcomes[days[1].events[0].id] = { status: "MEASURED", hit: true, first: "T1" };
  const a = sc.aggregate(days, { minSample: 30 });
  const T = a.sections.TURN;
  assert.deepEqual([T.events, T.measurable, T.excludedUnmeasurable, T.hits, T.hitRate, T.tooFewToJudge], [3, 2, 1, 1, 0.5, true]);
  assert.equal(T.meanForward.m60.pts, 15);
  assert.equal(T.byStage.EARLY.measurable, 1);
  assert.equal(a.sections.SIGNAL.byDecision.VETOED.hits, 1);
  assert.equal(a.backfilledSessions, 1);
  assert.match(sc.aggregateToCsv(a), /^section,split,sessions/);
  assert.equal(sc.aggregate(days, { includeTrades: false }).sections.TRADE, undefined);
});

// ── API: public vs authenticated ──

function apiHarness(store) {
  return createScorecardHandler({ store, now: () => Date.UTC(2026, 10, 12, 12, 0), getTimeline: async () => [], settings: () => ({ secretish: "settings" }), send: async () => true });
}
async function call(h, query = {}, headers = {}) {
  const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } };
  await h({ method: "GET", query, headers }, res);
  return res;
}

test("API: public day view hides rupee results and settings; authenticated shows them; CSV", async () => {
  const prev = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = SECRET;
  try {
    const store = fakeStore();
    const tr = sc.buildTradeEvent({ kind: "FLOW", tradeId: "ft-1", exitGrade: "TARGET_2_HIT", direction: "SHORT", entry: 25000, exitPrice: 24860, pnlInr: 1070, pnlKnown: true, nowMs: 0 });
    store.kv[sc.keys.day("2026-11-11")] = { v: 1, date: "2026-11-11", finalisedAt: "x", settings: { a: 1 }, series: { m: [] }, events: [tr], outcomes: { [tr.id]: { status: "MEASURED", pnlInr: 1070, hit: true } }, dataQuality: { state: "OK", coveragePct: 100 } };
    const h = apiHarness(store);
    const pub = await call(h, { date: "2026-11-11" });
    assert.equal(pub.body.settings, undefined);
    assert.equal(pub.body.events[0].data.pnlInr, undefined);
    assert.equal(pub.body.outcomes[tr.id].pnlInr, undefined);
    const auth = await call(h, { date: "2026-11-11", key: SECRET });
    assert.deepEqual(auth.body.settings, { a: 1 });
    assert.equal(auth.body.events[0].data.pnlInr, 1070);
    assert.equal((await call(h, { date: "2026-11-11", key: "wrong" })).statusCode, 401);
    const csv = await call(h, { date: "2026-11-11", format: "csv" });
    assert.match(csv.body, /^date,time,section/);
    assert.ok(!csv.body.includes("1070"), "no rupee figure in the public CSV");
    const aggPub = await call(h, { days: "30" });
    assert.equal(aggPub.body.sections.TRADE, undefined, "rupee statistics only for an authenticated caller");
    const aggAuth = await call(h, { days: "30", key: SECRET });
    assert.equal(aggAuth.body.sections.TRADE.hits, 1);
    assert.equal(aggAuth.body.sections.TRADE.tooFewToJudge, true);
  } finally {
    if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev;
  }
});

test("API: a past unfinalised day is finalised lazily on read (once)", async () => {
  const store = fakeStore();
  store.lists[sc.keys.events("2026-11-11")] = [{ id: "A", t: 0, minutes: 600, time: "10:00", section: "TURN", type: "EARLY", direction: "BULLISH", futPrice: 25000, data: {}, dq: { ok: true } }];
  const sent = [];
  const h = createScorecardHandler({ store, now: () => Date.UTC(2026, 10, 12, 4, 0), getTimeline: async () => path([[555, 25000], [700, 25100]]), settings: () => ({}), send: async (t) => { sent.push(t); return true; } });
  const r = await call(h, { date: "2026-11-11" });
  assert.equal(r.body.outcomes.A.status, "MEASURED");
  assert.ok(store.kv[sc.keys.day("2026-11-11")].finalisedAt);
  await call(h, { date: "2026-11-11" });
  assert.equal(sent.length, 1);
});

// ── recorder: dedupe, cap, storage ──

test("recordReading: concurrent refreshes record an event once; disabled flag records nothing", async () => {
  const store = fakeStore();
  const date = "2026-11-12";
  store.kv[sc.keys.state(date)] = { fusionQuadrant: "LONG_BUILDUP", fusionScenario: null, turn: {}, radarKeys: [], eod: { lastSlot: null, lastCategory: null, last: null } };
  const r = reading(601, { fusion: { quadrant: "SHORT_BUILDUP", scenario: null } });
  await Promise.all([sc.recordReading({ store, date, reading: r, env: {} }), sc.recordReading({ store, date, reading: r, env: {} })]);
  assert.equal(store.lists[sc.keys.events(date)].length, 1);
  const off = fakeStore();
  assert.equal((await sc.recordReading({ store: off, date, reading: r, env: { SCORECARD_ENABLED: "false" } })).status, "DISABLED");
  assert.deepEqual(off.kv, {});
});

test("storage bound: events capped per day with a dropped counter; full-day document stays small", async () => {
  const store = fakeStore();
  const date = "2026-11-12";
  for (let i = 0; i < sc.SC_MAX_EVENTS_PER_DAY + 5; i++) {
    await sc.recordEvent({ store, date, event: { ...ev({ minutes: 600 }), id: `X${i}` }, env: {} });
  }
  assert.equal(store.lists[sc.keys.events(date)].length, sc.SC_MAX_EVENTS_PER_DAY);
  assert.equal(store.kv[sc.keys.dropped(date)], 5);

  // A complete session (386 ticks with volume) and a realistic day of 60 events.
  const tl = path([[555, 25000], [700, 25150], [940, 25050]]).map((t, i) => ({ ...t, futVolume: 1000000 + i * 15000 }));
  const series = sc.compactSeries(tl);
  assert.equal(series.m.length, 386);
  assert.equal(series.v[385], 1000000 + 385 * 15000, "cumulative futures volume is recorded per tick");
  const events = Array.from({ length: 60 }, (_, i) => ({ ...ev({ minutes: 560 + i * 6, direction: "BULLISH", futPrice: 25050 }), id: `E${i}`, data: { stage: "EARLY", futures: { movePts: -50, movePct: -0.2, oiChange: 500, oiPct: 0.25 }, options: { putLegDelta: 1, callLegDelta: 2, netDelta: 3 } } }));
  const doc = sc.buildDayDoc({ date, events, series, settings: {}, finalEvent: null });
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  assert.ok(bytes < 120000, `typical full day ${bytes} bytes`);
  const worst = sc.buildDayDoc({ date, events: Array.from({ length: sc.SC_MAX_EVENTS_PER_DAY }, (_, i) => ({ ...events[i % 60], id: `W${i}` })), series, settings: {}, finalEvent: null });
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) < 900000, "worst case below Upstash's 1 MB request limit");
});

// ── decisions provably unchanged ──

test("decisions unchanged: same webhook decision with the recorder on and off; EOD verdict untouched", async () => {
  const run = async (enabled) => {
    const prev = { s: process.env.TV_WEBHOOK_SECRET, e: process.env.SCORECARD_ENABLED };
    process.env.TV_WEBHOOK_SECRET = SECRET;
    process.env.SCORECARD_ENABLED = enabled ? "true" : "false";
    const store = {};
    const lists = {};
    const redis = {
      async get(k) { return store[k] ?? null; },
      async set(k, v, o = {}) { if (o.nx && k in store) return null; store[k] = v; return "OK"; },
      async del(k) { delete store[k]; return 1; },
      async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
      async rpush(k, v) { (lists[k] ||= []).push(v); return lists[k].length; },
      async ltrim() { return "OK"; },
      async lrange(k) { return lists[k] || []; },
    };
    store["nifty:flow:latest"] = JSON.stringify({ snapshotAt: Date.now() - 10000, corridor: { deltaPCR: 0.6, floorStrike: 24700, roofStrike: 25200 }, futures: { quadrant: "SHORT_BUILDUP" }, smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" } });
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({ now: () => Date.UTC(2026, 10, 12, 5, 0), isLiveMarket: async () => false, refresh: async () => ({ ok: false }), sendText: async () => true, newTradeId: () => "ft-fixed" });
    try {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } };
      await webhook.default({ method: "POST", query: {}, headers: {}, body: JSON.stringify({ secret: SECRET, grade: "SYNERGY_BEAR", dir: "SHORT", tf: "15", close: 24960, sl: 25025, cappedSl: 25025, rDist: 65, t1Dist: 65, t2Dist: 130 }) }, res);
      return { res, lists };
    } finally {
      webhook.setRedisClientForTesting(null);
      webhook.setWebhookDepsForTesting(null);
      if (prev.s === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev.s;
      if (prev.e === undefined) delete process.env.SCORECARD_ENABLED; else process.env.SCORECARD_ENABLED = prev.e;
    }
  };
  const on = await run(true);
  const off = await run(false);
  for (const k of ["decision", "recommendedLots", "tier", "stopLoss", "target1Price", "target2Price", "reasoning", "tradeId"]) {
    assert.deepEqual(on.res.body.fusedVerdict[k], off.res.body.fusedVerdict[k], k);
  }
  assert.equal(on.res.body.decision, off.res.body.decision);
  assert.equal(on.lists["nifty:sc:events:2026-11-12"].length, 1, "recorder on: the signal was recorded");
  assert.equal(off.lists["nifty:sc:events:2026-11-12"], undefined, "recorder off: nothing recorded");

  // EOD: the reading is built from the decision object without touching it.
  const args = { spot: 24637, floorStrike: 24400, roofStrike: 24650, totPutWriting: 200000, totCallWriting: 200000, pcr: 1, deltaPcr: 1, timeline: [], dayOfWeek: 3, nowMins: 930 };
  const a = calculateEODDecision(args);
  const before = JSON.stringify(a);
  const reading2 = buildScorecardReading({ nowMs: 0, minutes: 930, futuresMetrics: { lastPrice: 25000 }, spot: 24637, dataQuality: { state: "OK" }, fusion: null, turnTracker: null, macroTurn: null, eodDecision: a });
  sc.captureEvents(null, reading2);
  assert.equal(JSON.stringify(a), before);
  assert.equal(JSON.stringify(calculateEODDecision(args)), before, "same verdict with or without recording");
});

// ── backfill ──

test("backfill of 11-Nov and 12-Nov: marked backfilled with gaps; 11-Nov STBT measured on 12-Nov's open; 12-Nov afternoon unmeasurable", () => {
  const [d11, d12] = buildBackfill();
  for (const d of [d11, d12]) {
    assert.equal(d.backfilled, true);
    assert.match(d.notes.join(" "), /BACKFILLED from a captured payload/);
    assert.match(d.notes.join(" "), /Data gaps: /);
  }
  assert.equal(d11.eodFinal.data.category, "STBT");
  assert.equal(d11.eodOutcome.status, "MEASURED");
  assert.deepEqual([d11.eodOutcome.price0920, d11.eodOutcome.hit, d11.eodOutcome.signedMove0920Pts], [25300, false, -51.1]);
  assert.equal(d12.eodOutcome.status, "PENDING");
  const after1138 = d12.events.filter((e) => e.minutes > 698);
  assert.ok(after1138.length >= 1);
  assert.ok(after1138.every((e) => d12.outcomes[e.id].status !== "MEASURED"), "nothing after 11:38 on 12-Nov is measurable");
  const confirmedBear = d12.events.find((e) => e.section === "TURN" && e.type === "CONFIRMED" && e.direction === "BEARISH");
  assert.equal(confirmedBear.time, "11:43");
  assert.equal(d12.outcomes[confirmedBear.id].status, "UNMEASURABLE");
  const morning = d12.events.filter((e) => e.minutes <= 640 && e.direction);
  assert.ok(morning.some((e) => d12.outcomes[e.id].status === "MEASURED"), "the gap-free morning is measurable");
});

test("Telegram texts carry no stray Markdown underscores and stay short", () => {
  const [d11, d12] = buildBackfill();
  for (const d of [d11, d12]) {
    const t = sc.formatDailyTelegram(d);
    assert.ok(!/_/.test(t.replace(/\*[^*]*\*/g, "")), t);
    assert.ok(t.length < 1500, `length ${t.length}`);
  }
  assert.match(sc.formatMorningTelegram("2026-11-11", d11.eodFinal, d11.eodOutcome), /EOD outcome 2026-11-11:\* STBT .*MISS \(2026-11-12\)/);
  assert.ok(!/_/.test(sc.formatMorningTelegram("2026-11-12", { data: { category: "NO_CARRY" } }, { status: "UNMEASURABLE", reason: "x" })));
});
