/**
 * 12-Nov-2026 calculation fixes (Part 2): since-open anchor, NO-CARRY threshold distance,
 * schedule-derived status label.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["CARRY_BRIDGE_ENABLED", "FLOW_BRIDGE_URL", "FLOW_BRIDGE_SECRET", "CARRY_WINDOW_START", "CARRY_WINDOW_END"]) delete process.env[k];

const { pickSessionFuturesAnchor, calculateEODDecision, eodScheduleLabel } = await import("../api/nifty-oi.js");
const { parseNseFuturesPayload } = await import("../src/smartMoneyFusion.js");
const { sendTelegramEODAlert } = await import("../api/tv-webhook.js");

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const futRows = (lastPrice, spot = 25200, oi = 150000) => ({
  data: [
    { underlying: "NIFTY", instrumentType: "FUTIDX", expiryDate: "25-Nov-2026", lastPrice, underlyingValue: spot, openInterest: oi },
    { underlying: "NIFTY", instrumentType: "FUTIDX", expiryDate: "30-Dec-2026", lastPrice: lastPrice + 100, underlyingValue: spot, openInterest: 60000 },
  ],
});

// ── 2.1 since-open anchor ──

test("anchor: skips a first tick with null / 0 futures and states the anchor time", () => {
  const timeline = [
    { time: "09:15", minutes: 555, spot: 25239.6, futPrice: null, futCombinedOI: null },
    { time: "09:16", minutes: 556, spot: 25241.0, futPrice: 0, futCombinedOI: 210000 },
    { time: "09:17", minutes: 557, spot: 25244.2, futPrice: 25301.5, futCombinedOI: 210400 },
  ];
  const a = pickSessionFuturesAnchor({ timeline });
  assert.equal(a.source, "timeline");
  assert.equal(a.time, "09:17");
  assert.equal(a.rawBasis, 57.3);
  assert.equal(a.futCombinedOI, 210400);
});

test("anchor: no valid tick and a poisoned Redis baseline (price 0 → basis −25,240) → null, never 0", () => {
  const timeline = [{ time: "09:15", minutes: 555, spot: 25239.6, futPrice: null }];
  const poisoned = { openOI: 210000, openBasis: -25239.6, openPrice: 0, timestamp: 1 };
  assert.equal(pickSessionFuturesAnchor({ timeline, cachedBase: poisoned }), null);
  const good = { openOI: 210000, openBasis: 61.2, openPrice: 25300, openSpot: 25238.8, time: "09:18" };
  const a = pickSessionFuturesAnchor({ timeline, cachedBase: good });
  assert.equal(a.source, "redis-baseline");
  assert.equal(a.time, "09:18");
  assert.equal(a.rawBasis, 61.2);
});

test("anchor: synthetic placeholder ticks and frozen-auction spot are never anchors", () => {
  const a = pickSessionFuturesAnchor({ timeline: [
    { time: "09:15", minutes: 555, spot: 25000, futPrice: 25060, futCombinedOI: 1, synthetic: true },
    { time: "15:20", minutes: 920, spot: 25000, futPrice: 25060, futCombinedOI: 1, spotFrozen: true },
  ] });
  assert.equal(a, null);
});

test("futures parse: a row without a traded price is not futures data; Δ since open is null without an anchor", () => {
  assert.equal(parseNseFuturesPayload(futRows(0), 25239.6), null, "lastPrice 0 → null (was a −25,240 basis)");
  const noAnchor = parseNseFuturesPayload(futRows(25300), 25239.6, null, null, null);
  assert.equal(noAnchor.intradayBasisDelta, null);
  const withAnchor = parseNseFuturesPayload(futRows(25300, 25239.6), 25239.6, 57.3, 210000, 25301.5);
  assert.equal(withAnchor.intradayBasisDelta, Number((25300 - 25239.6 - 57.3).toFixed(2)));
});

test("regression 12-Nov: null-futures 09:15 tick no longer produces 'basis … Δ 25302' in the EOD audit", () => {
  const base = {
    spot: 25239.6, floorStrike: 25100, roofStrike: 25400, totPutWriting: 200000, totCallWriting: 200000,
    pcr: 1, deltaPcr: 1, timeline: [], dayOfWeek: 4, nowMins: 700, futuresQuadrant: { quadrant: "SHORT_BUILDUP" },
  };
  // What the bad baseline produced: rawBasis − (0 − spot).
  const before = calculateEODDecision({ ...base, futuresMetrics: { rawBasis: 62.8, adjustedBasisSpread: 10, intradayBasisDelta: 25302.42 } });
  assert.match(before.audit.find((x) => x.label === "Futures Quadrant & Basis").detail, /Δ 25302\.42/);

  // Now: the anchor comes from the first valid tick, or the delta is reported unavailable.
  const anchored = calculateEODDecision({ ...base, futuresMetrics: { rawBasis: 62.8, adjustedBasisSpread: 10, intradayBasisDelta: 5.5, intradayBasisAnchor: { time: "09:17" } } });
  assert.match(anchored.audit.find((x) => x.label === "Futures Quadrant & Basis").detail, /Δ 5\.5 since 09:17/);
  const none = calculateEODDecision({ ...base, futuresMetrics: { rawBasis: 62.8, adjustedBasisSpread: 10, intradayBasisDelta: null, intradayBasisAnchor: null } });
  const detail = none.audit.find((x) => x.label === "Futures Quadrant & Basis").detail;
  assert.match(detail, /Δ since open unavailable \(no valid session anchor tick\)/);
  assert.doesNotMatch(detail, /Δ \d/);
});

// ── 2.2 NO CARRY: no agreement percentage ──

const closing = (callEnd) => {
  const out = [];
  for (let m = 855; m <= 930; m++) {
    const call = 300000 + ((callEnd - 300000) * (m - 855)) / 75;
    out.push({ minutes: m, time: hm(m), putWriting: 300000, callWriting: call, netDiff: 300000 - call, isLiveTick: true });
  }
  return out;
};
const eodBase = { spot: 24637, floorStrike: 24400, roofStrike: 24650, totPutWriting: 200000, totCallWriting: 200000, pcr: 1, deltaPcr: 1, dayOfWeek: 3, nowMins: 930,
  futuresQuadrant: { quadrant: "NEUTRAL_CHOP" }, futuresMetrics: { rawBasis: 5 } };

test("NO CARRY (score 0): no agreement / conviction figure; distance to each threshold instead", () => {
  const r = calculateEODDecision({ ...eodBase, timeline: closing(300000) });
  assert.equal(r.verdict, "EXIT TO CASH / DO NOT CARRY");
  assert.equal(r.score, 0);
  assert.equal(r.conviction, null, "12-Nov showed 90 here");
  assert.equal(r.agreement.value, null);
  assert.equal(r.agreement.kind, "THRESHOLD_DISTANCE");
  assert.deepEqual([r.thresholdDistance.toBtst, r.thresholdDistance.toStbt], [3, 3]);
  assert.equal(r.thresholdDistance.text, "Score +0 · 3 pts short of BTST (≥ +3) · 3 pts short of STBT (≤ −3)");
});

test("BTST/STBT keep the rule agreement figure", () => {
  const r = calculateEODDecision({ ...eodBase, timeline: closing(400000) });
  assert.equal(r.verdict, "CARRY NIFTY PE (STBT)");
  assert.equal(r.agreement.kind, "RULE_BASED_AGREEMENT");
  assert.ok(Number.isFinite(r.conviction));
  assert.equal(r.agreement.value, r.conviction);
});

test("EOD Telegram: a NO CARRY message shows the threshold distance, not an agreement percentage", async () => {
  const prev = { fetch: globalThis.fetch, t: process.env.TELEGRAM_BOT_TOKEN, c: process.env.TELEGRAM_CHAT_ID };
  const texts = [];
  process.env.TELEGRAM_BOT_TOKEN = "x";
  process.env.TELEGRAM_CHAT_ID = "y";
  globalThis.fetch = async (u, init) => { texts.push(JSON.parse(init.body).text); return new Response("{}", { status: 200 }); };
  try {
    const r = calculateEODDecision({ ...eodBase, timeline: closing(300000) });
    await sendTelegramEODAlert(r, 24500, 24400, 24650, "15:15");
    assert.match(texts[0], /Score vs thresholds:\* Score \+0 · 3 pts short of BTST/);
    assert.doesNotMatch(texts[0], /Agreement: `/);
  } finally {
    globalThis.fetch = prev.fetch;
    if (prev.t === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prev.t;
    if (prev.c === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prev.c;
  }
});

// ── 2.3 status label from the real schedule ──

test("status label follows the schedule constants (alerts 14:15–15:38, carry 15:31–15:37, close 15:40)", () => {
  const off = {};
  assert.equal(eodScheduleLabel({ nowMins: 600, env: off }), "MONITORING · EOD alerts 14:15–15:38 · carry instruction 15:31–15:37 (automation off) · close 15:40 IST");
  assert.equal(eodScheduleLabel({ nowMins: 900, env: off }), "EOD ALERT WINDOW (14:15–15:38 IST) · carry instruction 15:31–15:37 (automation off) · close 15:40");
  assert.equal(eodScheduleLabel({ nowMins: 933, env: off }), "CARRY INSTRUCTION WINDOW (15:31–15:37 IST) · automation off · EOD alerts until 15:38 · close 15:40");
  assert.equal(eodScheduleLabel({ nowMins: 939, env: off }), "FINAL MINUTES · EOD alerts until 15:38 · close 15:40 IST");
  assert.equal(eodScheduleLabel({ nowMins: 950, env: off }), "MARKET CLOSED · EOD DECISION SETTLED AT 15:40 IST (Active until 23:00 IST)");
  assert.equal(eodScheduleLabel({ nowMins: 500, env: off }), "PRE-MARKET · AWAITING 09:15 IST OPEN");
  const on = { CARRY_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://a.test/x", FLOW_BRIDGE_SECRET: "s", CARRY_WINDOW_START: "15:32", CARRY_WINDOW_END: "15:36" };
  assert.equal(eodScheduleLabel({ nowMins: 931, env: on }), "EOD ALERT WINDOW (14:15–15:38 IST) · carry instruction 15:32–15:36 · close 15:40");
  assert.equal(eodScheduleLabel({ nowMins: 933, env: on }), "CARRY INSTRUCTION WINDOW (15:32–15:36 IST) · EOD alerts until 15:38 · close 15:40");
  const r = calculateEODDecision({ ...eodBase, timeline: closing(300000), nowMins: 905 });
  assert.doesNotMatch(r.statusLabel, /15:00 - 15:25/);
  assert.match(r.statusLabel, /EOD ALERT WINDOW/);
});
