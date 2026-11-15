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

// ── 13-Nov: stale carry-over futures quote at the open ──

const NOV13 = [
  ["09:15", 25314, 25209.85, 216128],
  ["09:16", 25314, 25152.95, 216128],
  ["09:17", 25170, 25135.75, 212215],
  ["09:18", 25165.9, 25111.95, 212638],
  ["09:19", 25163, 25124.05, 212638],
  ["09:20", 25155, 25128.7, 212782],
  ["09:21", 25155, 25115.85, 212979],
  ["09:22", 25123, 25088.75, 212922],
  ["09:23", 25123, 25078.3, 212922],
  ["09:24", 25111, 25095.05, 212872],
  ["09:25", 25116.7, 25119.75, 212872],
  ["09:26", 25145, 25123.5, 213130],
].map(([time, futPrice, spot, futCombinedOI]) => {
  const [h, m] = time.split(":").map(Number);
  return { time, minutes: h * 60 + m, futPrice, spot, futCombinedOI };
});

test("anchor 13-Nov: the stale 09:15/09:16 carry-over quote is skipped; anchor is 09:17", () => {
  const a = pickSessionFuturesAnchor({ timeline: NOV13 });
  assert.equal(a.source, "timeline");
  assert.equal(a.time, "09:17");
  assert.equal(a.futPrice, 25170);
  assert.equal(a.futCombinedOI, 212215);
  assert.equal(a.rawBasis, 34.25);
  assert.equal(a.provisional, false);
  assert.equal(a.skippedStaleTicks, 2);
  // Order of the input does not matter.
  assert.equal(pickSessionFuturesAnchor({ timeline: NOV13.slice().reverse() }).time, "09:17");
});

test("anchor 13-Nov: provisional at the open, self-corrects to 09:17 as ticks arrive", () => {
  for (const n of [1, 2, 3]) {
    const a = pickSessionFuturesAnchor({ timeline: NOV13.slice(0, n) });
    assert.equal(a.time, "09:15", `${n} tick(s)`);
    assert.equal(a.provisional, true, `${n} tick(s)`);
    assert.equal(a.skippedStaleTicks, 0);
    assert.ok(a.reason);
  }
  // 4–5 ticks: 09:15 (then 09:16) can already be judged stale; the next candidate is still unconfirmed.
  const a4 = pickSessionFuturesAnchor({ timeline: NOV13.slice(0, 4) });
  assert.deepEqual([a4.time, a4.provisional, a4.skippedStaleTicks], ["09:16", true, 1]);
  const a5 = pickSessionFuturesAnchor({ timeline: NOV13.slice(0, 5) });
  assert.deepEqual([a5.time, a5.provisional, a5.skippedStaleTicks], ["09:17", true, 2]);
  for (let n = 6; n <= NOV13.length; n++) {
    const a = pickSessionFuturesAnchor({ timeline: NOV13.slice(0, n) });
    assert.deepEqual([a.time, a.provisional, a.skippedStaleTicks, a.rawBasis], ["09:17", false, 2, 34.25], `${n} ticks`);
  }
});

const series = (n, basisAt, oiAt, start = 555) =>
  Array.from({ length: n }, (_, i) => {
    const futPrice = Number((25200 + 3 * Math.sin(i)).toFixed(2));
    return { time: hm(start + i), minutes: start + i, futPrice, spot: Number((futPrice - basisAt(i)).toFixed(2)), futCombinedOI: Math.round(oiAt(i)) };
  });

test("anchor: a normal open (basis within a few points, OI drift < 0.3%) anchors on the first tick", () => {
  const tl = series(20, (i) => 40 + (i % 3) - 1, (i) => 210000 * (1 + 0.00012 * i));
  const a = pickSessionFuturesAnchor({ timeline: tl });
  assert.deepEqual([a.time, a.provisional, a.skippedStaleTicks], ["09:15", false, 0]);
  assert.equal(a.reason, undefined);
});

test("anchor: a volatile but live open (basis ±20 pts, OI moving 0.5%) is not rejected", () => {
  const swing = [20, -15, 5, -20, 10, -5, 18, -12, 0, 15, -18, 8, -3, 12, -8, 20, -20, 4, -6, 16];
  const tl = series(20, (i) => 45 + swing[i], (i) => 210000 * (1 + (i % 2 ? 0.005 : 0) + 0.0001 * i));
  const a = pickSessionFuturesAnchor({ timeline: tl });
  assert.deepEqual([a.time, a.provisional, a.skippedStaleTicks], ["09:15", false, 0]);
});

test("anchor: when every early candidate looks stale, fall back to the first valid tick (provisional, with a reason) — never null", () => {
  // OI alternating ±2% every tick: each candidate disagrees with the median of its followers.
  const tl = series(30, () => 40, (i) => 210000 * (i % 2 ? 0.98 : 1.02));
  const a = pickSessionFuturesAnchor({ timeline: tl });
  assert.notEqual(a, null);
  assert.equal(a.time, "09:15");
  assert.equal(a.futCombinedOI, 214200);
  assert.equal(a.provisional, true);
  assert.match(a.reason, /all first 15 valid ticks disagreed/);
});

test("anchor: sparse capture (fewer than 3 ticks within 10 min, window closed) accepts the tick as before", () => {
  const tl = [
    { time: "09:15", minutes: 555, spot: 25200, futPrice: 25240, futCombinedOI: 210000 },
    { time: "09:30", minutes: 570, spot: 25210, futPrice: 25251, futCombinedOI: 210300 },
  ];
  const a = pickSessionFuturesAnchor({ timeline: tl });
  assert.deepEqual([a.time, a.provisional, a.skippedStaleTicks], ["09:15", false, 0]);
});

test("anchor: a timeline anchor always wins over the Redis baseline", () => {
  const stale = { openOI: 216128, openBasis: 104.15, openPrice: 25314, openSpot: 25209.85, time: "09:15" };
  const a = pickSessionFuturesAnchor({ timeline: NOV13, cachedBase: stale });
  assert.deepEqual([a.source, a.time], ["timeline", "09:17"]);
  const early = pickSessionFuturesAnchor({ timeline: NOV13.slice(0, 1), cachedBase: stale });
  assert.equal(early.source, "timeline");
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
