/**
 * Daily swing summary + Weekly Outlook (shadow). Pure modules, the read-only API handler with an
 * injected store, the capture guard / capture runner with injected deps, and non-interference with
 * the refresh core (fake NSE + fake Upstash; nothing leaves the process).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "CARRY_BRIDGE_ENABLED",
]) delete process.env[k];
for (const k of Object.keys(process.env)) if (k.startsWith("SWING_")) delete process.env[k];
const FAKE_REDIS = "https://fake-redis-swing.invalid";
process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS;
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

const {
  summariseChain, buildDailySummary, summaryFromScorecardDoc, getSwingConfig, shouldCaptureSwing,
  runSwingCapture, planExtraChains, swingKeys, loadSwingHistory, dteFromExpiry,
} = await import("../src/swingSummary.js");
const { computeWeeklyOutlook, evaluateOutlookOutcome, getOutlookConfig, chooseHorizon } = await import("../src/weeklyOutlook.js");
const { createSwingHandler, clampDays } = await import("../api/swing.js");
const { keys: scKeys } = await import("../src/scorecard.js");
const { PRICE_DEADBAND_PCT, OI_DEADBAND_PCT } = await import("../src/smartMoneyFusion.js");
const nifty = await import("../api/nifty-oi.js");

const CFG = getOutlookConfig({});

// ─────────────────────────── helpers ───────────────────────────
function rows(spot, { step = 50, width = 500, callWall = null, putWall = null, ltp = true } = {}) {
  const out = [];
  for (let k = spot - width; k <= spot + width; k += step) {
    const dist = Math.abs(k - spot);
    out.push({
      strikePrice: k,
      CE: { openInterest: k === callWall ? 900000 : 10000 + (k > spot ? 1000 : 0), changeinOpenInterest: 100, lastPrice: ltp ? Math.max(1, 150 - (k - spot) * 0.5) : 0 },
      PE: { openInterest: k === putWall ? 800000 : 10000 + (k < spot ? 1000 : 0), changeinOpenInterest: 100, lastPrice: ltp ? Math.max(1, 150 + (k - spot) * 0.5) : 0 },
    });
    void dist;
  }
  return out;
}

const chain = ({ expiry = "24-Nov-2026", spot, straddle = 300, callWall, putWall, pcr = 1.0, dte = 8 }) => ({
  expiry, spot, atm: Math.round(spot / 50) * 50, straddle, expectedRange: { low: spot - straddle, high: spot + straddle },
  callWall, putWall, pcr, dte, topCallOi: [], topPutOi: [], strikeCount: 21,
});

function day(date, { close, high = close + 50, low = close - 80, futClose = close + 20, oi = 200000, fexp = "24-Nov-2026", near = null, nextWeekly = null, monthly = null, partial = false }) {
  return {
    v: 1, date, source: "capture", partial,
    spot: { open: close - 10, high, low, close },
    fut: { open: futClose - 10, high: futClose + 50, low: futClose - 80, close: futClose, oiOpen: oi, oiClose: oi, oiChangePct: 0, volume: 1, expiry: fexp },
    chains: { near, nextWeekly, monthly }, nearIntraday: null, coveragePct: 99, notes: [],
  };
}

const WEEK1 = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
const SIX = [...WEEK1, "2026-11-16"];

function uptrendDays({ partialLast = false } = {}) {
  const closes = [25000, 25100, 25200, 25300, 25400, 25500];
  return SIX.map((d, i) => {
    const isLast = i === SIX.length - 1;
    const isPrev = i === SIX.length - 2;
    const near = isLast
      ? chain({ spot: 25500, straddle: 300, putWall: 25300, callWall: 26000, pcr: 1.3 })
      : isPrev ? chain({ spot: 25400, straddle: 300, putWall: 25200, callWall: 26000, pcr: 1.2 }) : null;
    return day(d, { close: closes[i], oi: 200000 * (1 + 0.01 * i), near, partial: isLast && partialLast });
  });
}

function downtrendDays() {
  const closes = [25500, 25400, 25300, 25200, 25100, 25000];
  return SIX.map((d, i) => {
    const isLast = i === SIX.length - 1;
    const isPrev = i === SIX.length - 2;
    const near = isLast
      ? chain({ spot: 25000, straddle: 300, putWall: 24500, callWall: 25200, pcr: 0.7 })
      : isPrev ? chain({ spot: 25100, straddle: 300, putWall: 24500, callWall: 25300, pcr: 0.8 }) : null;
    return day(d, { close: closes[i], high: closes[i] + 80, low: closes[i] - 50, oi: 200000 * (1 + 0.01 * i), near });
  });
}

function rangeDays() {
  const closes = [25000, 25020, 24990, 25010, 24995, 25005];
  return SIX.map((d, i) => day(d, {
    close: closes[i], high: closes[i] + 60, low: closes[i] - 60, oi: 200000,
    near: i === SIX.length - 1 ? chain({ spot: 25005, straddle: 300, putWall: 24700, callWall: 25300, pcr: 1.0 }) : null,
  }));
}

function breakUpDays() {
  const closes = [25000, 24950, 25050, 24980, 25010, 25200];
  return SIX.map((d, i) => day(d, {
    close: closes[i], high: closes[i] + 200, low: closes[i] - 200, oi: 200000 * (1 - 0.01 * i),
    near: i === SIX.length - 1 ? chain({ spot: 25200, straddle: 250, putWall: 24800, callWall: 25250, pcr: 1.0, dte: 4 }) : null,
  }));
}

// ─────────────────────────── summariseChain ───────────────────────────
test("summariseChain: ATM, straddle, walls, PCR, expected range", () => {
  const r = summariseChain({ rows: rows(25000, { callWall: 25300, putWall: 24700 }), spot: 25010, expiry: "24-Nov-2026", dte: 8 });
  assert.equal(r.atm, 25000);
  assert.equal(r.straddle, r.ceLtp + r.peLtp);
  assert.equal(r.straddle, 300);
  assert.deepEqual(r.expectedRange, { low: 24710, high: 25310 });
  assert.equal(r.callWall, 25300);
  assert.equal(r.putWall, 24700);
  assert.equal(r.topCallOi.length, 3);
  assert.equal(r.topCallOi[0].oi, 900000);
  assert.equal(r.topPutOi[0].strike, 24700);
  assert.equal(r.pcr, Number((r.totPutOI / r.totCallOI).toFixed(2)));
  assert.equal(r.dte, 8);
  assert.equal(r.strikeCount, 21);
  assert.equal(r.partial, false);
});

test("summariseChain: ATM skips a strike with an unpriced leg and flags it", () => {
  const rs = rows(25000);
  rs.find((x) => x.strikePrice === 25000).PE.lastPrice = 0;
  const r = summariseChain({ rows: rs, spot: 25000, expiry: "24-Nov-2026", dte: 8 });
  assert.notEqual(r.atm, 25000);
  assert.equal(Math.abs(r.atm - 25000), 50);
  assert.equal(r.partial, true);
  assert.match(r.notes[0], /unpriced leg/);
});

test("summariseChain: empty chain, no priced pair, garbage → null, never throws", () => {
  assert.equal(summariseChain({ rows: [], spot: 25000 }), null);
  assert.equal(summariseChain({ rows: rows(25000, { ltp: false }), spot: 25000 }), null);
  assert.equal(summariseChain({ rows: rows(25000), spot: 0 }), null);
  assert.equal(summariseChain({ rows: null, spot: 25000 }), null);
  assert.equal(summariseChain(), null);
  assert.equal(summariseChain({ rows: [null, 5, "x", { strikePrice: "abc" }, { strikePrice: 100, CE: null }], spot: 100 }), null);
  assert.doesNotThrow(() => summariseChain({ rows: [{ get strikePrice() { throw new Error("x"); } }], spot: 1 }));
});

test("dteFromExpiry matches calculateDte semantics", () => {
  const now = Date.UTC(2026, 10, 13, 10, 5); // Fri 15:35 IST
  assert.equal(dteFromExpiry("17-Nov-2026", now), 4);
  assert.equal(dteFromExpiry("13-Nov-2026", now), 0);
  assert.equal(nifty.calculateDte("17-Nov-2026", new Date(now)), 4);
});

// ─────────────────────────── buildDailySummary ───────────────────────────
function syntheticTimeline() {
  return [
    // Stale carry-over futures quotes: the previous session's price, OI and cumulative volume, as
    // the real feed repeats them (13-Nov, 16-Nov, 17-Nov). The volume reset at 09:17 marks the live open.
    { minutes: 555, spot: 25000, futPrice: 25300, futCombinedOI: 190000, futVolume: 3500000 },
    { minutes: 556, spot: 25010, futPrice: 25310, futCombinedOI: 190500, futVolume: 3500000 },
    { minutes: 557, spot: 25020, futPrice: 25050, futCombinedOI: 200000, futVolume: 1000 },
    { minutes: 600, spot: 25200, futPrice: 25230, futCombinedOI: 201000, futVolume: 5000 },
    { minutes: 650, spot: 26000, futPrice: 26100, futCombinedOI: 999999, synthetic: true },
    { minutes: 700, spot: 24900, futPrice: 24920, futCombinedOI: 202000, futVolume: 9000 },
    { minutes: 920, spot: 25500, futPrice: 25110, futCombinedOI: 203000, spotFrozen: true, futVolume: 11000 },
    { minutes: 936, spot: 25100, futPrice: 25120, futCombinedOI: 204000, spotFrozen: false, futVolume: 12000, floor: 25000, roof: 25200, putWriting: 300, callWriting: 200 },
  ];
}

test("buildDailySummary: OHLC from real ticks; synthetic and frozen ticks excluded; futures from the first live tick", () => {
  const near = summariseChain({ rows: rows(25100), spot: 25100, expiry: "17-Nov-2026", dte: 6 });
  const s = buildDailySummary({ date: "2026-11-11", timeline: syntheticTimeline(), near, dataQuality: { coveragePct: 97 }, nowMs: Date.UTC(2026, 10, 11, 10, 5) });
  assert.deepEqual(s.spot, { open: 25000, high: 25200, low: 24900, close: 25100 });
  assert.equal(s.fut.open, 25050);
  assert.equal(s.fut.high, 25230);
  assert.equal(s.fut.low, 24920);
  assert.equal(s.fut.close, 25120);
  assert.equal(s.fut.oiOpen, 200000);
  assert.equal(s.fut.oiClose, 204000);
  assert.equal(s.fut.oiChangePct, 2);
  assert.equal(s.fut.volume, 12000, "the carry-over quote's previous-session volume (3.5M) is not today's volume");
  assert.equal(s.ticks, 7);
  assert.ok(s.notes.some((n) => /from 09:17: 2 opening carry-over quote\(s\) skipped/.test(n)));
  assert.equal(s.nearIntraday.floor, 25000);
  assert.equal(s.nearIntraday.totalPutWriting, 300);
  assert.equal(s.chains.near.expiry, "17-Nov-2026");
  assert.equal(s.chains.nextWeekly, null);
  assert.ok(s.notes.includes("next-weekly chain not captured"));
  assert.ok(s.notes.includes("monthly chain not captured"));
  assert.equal(s.partial, false, "missing next/monthly chains alone do not make the day partial");
  assert.equal(s.coveragePct, 97);
  assert.equal(s.capturedAt, "2026-11-11T10:05:00.000Z");
});

test("buildDailySummary: partial flag (no near chain / low coverage / no ticks)", () => {
  assert.equal(buildDailySummary({ date: "2026-11-11", timeline: syntheticTimeline(), near: null }).partial, true);
  const near = summariseChain({ rows: rows(25100), spot: 25100, expiry: "17-Nov-2026", dte: 6 });
  assert.equal(buildDailySummary({ date: "2026-11-11", timeline: syntheticTimeline(), near, dataQuality: { coveragePct: 30 } }).partial, true);
  const empty = buildDailySummary({ date: "2026-11-11", timeline: [], near });
  assert.equal(empty.partial, true);
  assert.equal(empty.spot, null);
  assert.equal(empty.fut, null);
  assert.doesNotThrow(() => buildDailySummary({ date: "x", timeline: "garbage" }));
  assert.doesNotThrow(() => buildDailySummary());
});

// 11-Nov-shaped: a run of isLiveTick:false gap-bridging ticks 160 points below everything else
// (linear spot, no futures price), then live ticks.
function elevenNovShaped(liveCount) {
  const tl = [{ minutes: 555, spot: 25339.3, futPrice: 25414.2, futCombinedOI: 212344, isLiveTick: false }];
  for (let i = 0; i < 8; i++) tl.push({ minutes: 556 + i, spot: 25005.82 + 0.47 * i, isLiveTick: false });
  for (let i = 0; i < liveCount; i++) {
    tl.push({ minutes: 564 + i * 10, spot: 25170 + (i % 5) * 40, futPrice: 25190 + (i % 5) * 40, futCombinedOI: 212000 + i, isLiveTick: true });
  }
  return tl;
}

test("buildDailySummary: with ≥ 30 live ticks, non-live gap-bridging ticks cannot set the low", () => {
  const s = buildDailySummary({ date: "2026-11-11", timeline: elevenNovShaped(30) });
  assert.equal(s.liveOnly, true);
  assert.equal(s.ticks, 39);
  assert.equal(s.ticksUsed, 30);
  assert.equal(s.nonLiveExcluded, 9);
  assert.equal(s.spot.low, 25170);
  assert.equal(s.spot.high, 25330);
  assert.equal(s.spot.open, 25170);
  assert.equal(s.fut.oiOpen, 212000);
  assert.ok(s.notes.some((n) => /9 non-live/.test(n)));
});

test("buildDailySummary: fewer than 30 live ticks → falls back to all non-synthetic ticks, with a note", () => {
  const s = buildDailySummary({ date: "2026-11-11", timeline: elevenNovShaped(29) });
  assert.equal(s.liveOnly, false);
  assert.equal(s.ticksUsed, 38);
  assert.equal(s.nonLiveExcluded, 0);
  assert.equal(s.spot.low, 25005.82);
  assert.ok(s.notes.some((n) => /only 29 live tick\(s\) \(< 30\)/.test(n)));
  const lowered = buildDailySummary({ date: "2026-11-11", timeline: elevenNovShaped(29), minLiveTicks: 20 });
  assert.equal(lowered.liveOnly, true);
  assert.equal(lowered.spot.low, 25170);
});

test("buildDailySummary: no carry-over evidence → futures open from the first tick", () => {
  const s = buildDailySummary({ date: "2026-11-11", timeline: [{ minutes: 555, spot: 1, futPrice: 10, futCombinedOI: 5 }, { minutes: 556, spot: 2, futPrice: 11, futCombinedOI: 6 }] });
  assert.equal(s.fut.open, 10);
  assert.ok(s.notes.some((n) => /futures open from the first tick \(09:15\)/.test(n)));
});

test("buildDailySummary: 17-Nov opening — the live open is 09:16 (volume reset), same as the scorecard", () => {
  // Real 17-Nov series start: 09:15 repeats Monday's close (cumulative volume 2,642,640).
  const tl = [
    { minutes: 555, spot: 25277.3, futPrice: 25318.5, futCombinedOI: 205523, futVolume: 2642640 },
    { minutes: 556, spot: 25312, futPrice: 25333.7, futCombinedOI: 203776, futVolume: 50440 },
    { minutes: 557, spot: 25329.85, futPrice: 25360, futCombinedOI: 203907, futVolume: 92495 },
    { minutes: 558, spot: 25340, futPrice: 25380, futCombinedOI: 204000, futVolume: 120000 },
  ];
  const s = buildDailySummary({ date: "2026-11-17", timeline: tl });
  assert.equal(s.fut.open, 25333.7, "not the 09:17 print (25360) the old fixed cut-off used");
  assert.equal(s.fut.oiOpen, 203776);
});

// ─────────────────────────── summaryFromScorecardDoc ───────────────────────────
function scorecardDoc(date = "2026-11-13") {
  return {
    v: 1, date, finalisedAt: "2026-11-13T10:10:00Z", events: [{ id: "e1" }], dataQuality: { coveragePct: 88 },
    series: {
      m: [555, 557, 600, 920, 936],
      s: [25300, 25310, 25400, 25600, 25350],
      f: [25500, 25320, 25420, 25390, 25370],
      o: [210000, 211000, 212000, 213000, 214000],
      // 09:15 repeats the previous session's cumulative volume (13-Nov real: 3,559,335).
      v: [3559335, 100, 200, 300, 400],
      p: [0, 10, 20, 30, 40],
      c: [0, 5, 10, 15, 20],
    },
  };
}

test("summaryFromScorecardDoc: partial OHLC from the series, frozen minutes skipped for spot high/low", () => {
  const s = summaryFromScorecardDoc(scorecardDoc());
  assert.equal(s.source, "scorecard-series");
  assert.equal(s.partial, true);
  assert.deepEqual(s.spot, { open: 25300, high: 25400, low: 25300, close: 25350 });
  assert.equal(s.fut.open, 25320);
  assert.equal(s.fut.high, 25420);
  assert.equal(s.fut.close, 25370);
  assert.equal(s.fut.oiOpen, 211000);
  assert.equal(s.fut.oiClose, 214000);
  assert.deepEqual(s.chains, { near: null, nextWeekly: null, monthly: null });
  assert.equal(s.coveragePct, 88);
  assert.equal(summaryFromScorecardDoc(null), null);
  assert.equal(summaryFromScorecardDoc({ date: "2026-11-13", series: { m: [] } }), null);
});

test("summaryFromScorecardDoc: a scorecard-shaped fixture is used if one exists (none is invented)", () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "fixtures");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  let checked = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (j && j.date && j.series && Array.isArray(j.series.m)) {
      const s = summaryFromScorecardDoc(j);
      assert.ok(s && s.spot && s.spot.low <= s.spot.high);
      checked += 1;
    }
  }
  assert.ok(checked >= 0); // no scorecard-shaped fixture exists today; the synthetic doc above covers it
});

// ─────────────────────────── computeWeeklyOutlook ───────────────────────────
test("outlook: 0 / 1 / 2 days → INSUFFICIENT_DATA, expected range present when a chain exists", () => {
  const z = computeWeeklyOutlook({ days: [] });
  assert.equal(z.regime, "INSUFFICIENT_DATA");
  assert.equal(z.expectedRange, null);
  assert.equal(z.daysUsed, 0);
  assert.equal(z.confidence, "LOW");
  assert.ok(z.headline.length > 0);
  for (const n of [1, 2]) {
    const ds = rangeDays().slice(-n);
    ds[ds.length - 1].chains.near = chain({ spot: 25005, putWall: 24700, callWall: 25300 });
    const o = computeWeeklyOutlook({ days: ds, config: CFG });
    assert.equal(o.regime, "INSUFFICIENT_DATA", `n=${n}`);
    assert.deepEqual(o.expectedRange, { low: 24705, high: 25305, straddle: 300, pctOfSpot: 1.2, expiry: "24-Nov-2026" });
    assert.equal(o.levels.callWall, 25300);
    assert.equal(o.groups.options.available, true);
    assert.equal(o.groups.price.needs, `${5 - n} more session${5 - n === 1 ? "" : "s"}`);
  }
  assert.doesNotThrow(() => computeWeeklyOutlook({ days: [null, 3, { date: "bad" }] }));
  assert.doesNotThrow(() => computeWeeklyOutlook());
});

test("outlook: 6-day uptrend with long build-up and a rising put wall → TREND_UP, invalidation at the put wall", () => {
  const o = computeWeeklyOutlook({ days: uptrendDays(), config: CFG });
  assert.equal(o.groups.price.score, 2);
  assert.equal(o.groups.futures.score, 2);
  assert.equal(o.groups.futures.inputs.quadrant, "LONG_BUILDUP");
  assert.equal(o.groups.options.score, 2);
  assert.equal(o.groups.options.inputs.migration.direction, "UP");
  assert.equal(o.score, 6);
  assert.equal(o.regime, "TREND_UP");
  assert.equal(o.confidence, "HIGH");
  assert.deepEqual(o.levels.invalidation, { value: 25300, side: "below", basis: "a daily close below the put wall 25300" });
  assert.equal(o.asOf, "2026-11-16");
  assert.equal(o.reference.spotClose, 25500);
  assert.match(o.headline, /Uptrend/);
  assert.equal(o.horizon.expiry, "24-Nov-2026");
});

test("outlook: mirror → TREND_DOWN, invalidation at the call wall", () => {
  const o = computeWeeklyOutlook({ days: downtrendDays(), config: CFG });
  assert.equal(o.groups.futures.inputs.quadrant, "SHORT_BUILDUP");
  assert.ok(o.groups.price.score < 0 && o.groups.options.score < 0);
  assert.equal(o.regime, "TREND_DOWN");
  assert.equal(o.levels.invalidation.value, 25200);
  assert.equal(o.levels.invalidation.side, "above");
});

test("outlook: flat days inside the walls → RANGE", () => {
  const o = computeWeeklyOutlook({ days: rangeDays(), config: CFG });
  assert.equal(o.regime, "RANGE");
  assert.equal(o.groups.futures.score, 0);
  assert.equal(o.groups.volatility.state, "NORMAL");
  assert.equal(o.levels.invalidation.side, "outside");
  assert.match(o.levels.invalidation.basis, /outside the expected range 24705–25305/);
  assert.equal(o.confidence, "HIGH");
});

test("outlook: close pressing the call wall with expanding realised range → BREAK_RISK_UP", () => {
  const o = computeWeeklyOutlook({ days: breakUpDays(), config: CFG });
  assert.ok(o.score < CFG.trendScore, `score ${o.score}`);
  assert.equal(o.groups.volatility.state, "EXPANDING");
  assert.equal(o.regime, "BREAK_RISK_UP");
  assert.equal(o.levels.invalidation.value, 24800);
  assert.equal(o.breakInfo.wall, 25250);
});

test("outlook: each group's `needs` text when under-supplied", () => {
  const ds = rangeDays().slice(-2).map((d) => ({ ...d, chains: { near: null, nextWeekly: null, monthly: null } }));
  const o = computeWeeklyOutlook({ days: ds, config: CFG });
  assert.equal(o.groups.price.needs, "3 more sessions");
  assert.equal(o.groups.futures.needs, "1 more session");
  assert.match(o.groups.options.needs, /option-chain capture/);
  assert.match(o.groups.volatility.needs, /option-chain capture/);
  const ds2 = rangeDays().slice(-2);
  ds2[1].chains.near = chain({ spot: 25005, putWall: 24700, callWall: 25300 });
  assert.equal(computeWeeklyOutlook({ days: ds2, config: CFG }).groups.volatility.needs, "1 more session");
});

test("outlook: confidence caps by available directional groups; partial last day → LOW", () => {
  // futures only (3 days, no chains) → 1 group → LOW
  const three = uptrendDays().slice(-3).map((d) => ({ ...d, chains: { near: null, nextWeekly: null, monthly: null } }));
  const o1 = computeWeeklyOutlook({ days: three, config: CFG });
  assert.equal(o1.directionalGroupsAvailable, 1);
  assert.equal(o1.confidence, "LOW");
  // futures + options (3 days with chains, < 5 price bars) → at most MEDIUM even when the base is HIGH
  const three2 = uptrendDays().slice(-3);
  const o2 = computeWeeklyOutlook({ days: three2, config: { ...CFG, highConfidenceScore: 4 } });
  assert.equal(o2.directionalGroupsAvailable, 2);
  assert.equal(o2.regime, "TREND_UP");
  assert.equal(o2.confidence, "MEDIUM");
  // all three → HIGH possible (see the TREND_UP test); partial last day → LOW
  const o3 = computeWeeklyOutlook({ days: uptrendDays({ partialLast: true }), config: CFG });
  assert.equal(o3.regime, "TREND_UP");
  assert.equal(o3.confidence, "LOW");
  assert.ok(o3.notes.some((n) => /partial/.test(n)));
});

test("outlook: outlook-expiry choice by days left on the near weekly", () => {
  const nearC = chain({ expiry: "17-Nov-2026", spot: 25000, dte: 5, putWall: 24800, callWall: 25200 });
  const nextC = chain({ expiry: "24-Nov-2026", spot: 25000, dte: 12, straddle: 400, putWall: 24500, callWall: 25500 });
  const mk = (near, next) => ({ date: "2026-11-12", chains: { near, nextWeekly: next, monthly: null } });
  assert.equal(chooseHorizon(mk(nearC, nextC), CFG).expiry, "17-Nov-2026");
  assert.equal(chooseHorizon(mk({ ...nearC, dte: 2 }, nextC), CFG).expiry, "24-Nov-2026");
  assert.equal(chooseHorizon(mk({ ...nearC, dte: 3 }, nextC), CFG).expiry, "17-Nov-2026");
  const fb = chooseHorizon(mk({ ...nearC, dte: 1 }, null), CFG);
  assert.equal(fb.expiry, "17-Nov-2026");
  assert.equal(fb.fallback, true);
  assert.match(fb.basis, /next weekly chain was not captured/);
  const o = computeWeeklyOutlook({ days: [{ ...day("2026-11-12", { close: 25000 }), chains: { near: { ...nearC, dte: 1 }, nextWeekly: null, monthly: null } }], config: CFG });
  assert.ok(o.notes.some((n) => /not captured/.test(n)));
  assert.equal(chooseHorizon(mk(null, null), CFG).expiry, null);
});

test("outlook: pivot basis with and without a full previous week", () => {
  const full = computeWeeklyOutlook({ days: uptrendDays(), config: CFG }); // last = Mon 16-Nov; week 9–13 Nov recorded (5)
  assert.match(full.levels.pivot.basis, /classic weekly pivot/);
  const wk = uptrendDays().slice(0, 5);
  const H = Math.max(...wk.map((d) => d.spot.high));
  const L = Math.min(...wk.map((d) => d.spot.low));
  const C = wk[4].spot.close;
  assert.equal(full.levels.pivot.value, Math.round(((H + L + C) / 3) * 100) / 100);
  assert.equal(full.levels.prevWeekHigh, H);
  assert.equal(full.levels.prevWeekLow, L);
  const partialWeek = uptrendDays().slice(2); // 11,12,13 Nov + 16 Nov: previous week has 3 sessions
  const p = computeWeeklyOutlook({ days: partialWeek, config: CFG });
  assert.match(p.levels.pivot.basis, /mean of the last/);
  // a Friday last session uses its own (complete) week
  const fri = computeWeeklyOutlook({ days: uptrendDays().slice(0, 5), config: CFG });
  assert.match(fri.levels.pivot.basis, /2026-11-09 to 2026-11-13/);
});

test("outlook: futures deadbands are the day-quadrant constants", () => {
  assert.equal(CFG.futPriceDeadbandPct, PRICE_DEADBAND_PCT);
  assert.equal(CFG.futOiDeadbandPct, OI_DEADBAND_PCT);
  const env = getOutlookConfig({ SWING_PCR_SUPPORTIVE: "1.5", SWING_TREND_SCORE: "abc" });
  assert.equal(env.pcrSupportive, 1.5);
  assert.equal(env.trendScore, 3);
});

// ─────────────────────────── evaluateOutlookOutcome ───────────────────────────
const later = (pairs) => pairs.map(([date, close]) => day(date, { close }));
const OUT = (regime, extra = {}) => ({ asOf: "2026-11-16", regime, reference: { spotClose: 25000 }, horizon: { expiry: "24-Nov-2026" }, expectedRange: { low: 24700, high: 25300, expiry: "24-Nov-2026" }, ...extra });

test("evaluateOutlookOutcome: pending until the horizon is recorded", () => {
  const r = evaluateOutlookOutcome({ outlook: OUT("TREND_UP"), laterDays: later([["2026-11-17", 25100], ["2026-11-18", 25200]]) });
  assert.equal(r.status, "PENDING");
  assert.equal(r.hit, null);
  assert.equal(evaluateOutlookOutcome({ outlook: null }).status, "PENDING");
});

test("evaluateOutlookOutcome: horizon by expiry date vs 5th session", () => {
  const ds = later([["2026-11-17", 25100], ["2026-11-18", 25150], ["2026-11-19", 25200], ["2026-11-20", 25250], ["2026-11-23", 25300], ["2026-11-24", 25350]]);
  const byFifth = evaluateOutlookOutcome({ outlook: OUT("TREND_UP"), laterDays: ds });
  assert.equal(byFifth.horizonDate, "2026-11-23");
  assert.equal(byFifth.horizonBasis, "5th session");
  const byExp = evaluateOutlookOutcome({ outlook: OUT("TREND_UP", { horizon: { expiry: "19-Nov-2026" } }), laterDays: ds });
  assert.equal(byExp.horizonDate, "2026-11-19");
  assert.equal(byExp.horizonBasis, "expiry");
  assert.equal(byExp.closeAtHorizon, 25200);
  assert.equal(byExp.movePct, 0.8);
});

test("evaluateOutlookOutcome: each regime's hit and miss", () => {
  const up = later([["2026-11-17", 25100], ["2026-11-18", 25350]]);
  const dn = later([["2026-11-17", 24900], ["2026-11-18", 24650]]);
  const flat = later([["2026-11-17", 25050], ["2026-11-18", 24950]]);
  const h = { horizon: { expiry: "18-Nov-2026" } };
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("TREND_UP", h), laterDays: up }).hit, true);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("TREND_UP", h), laterDays: dn }).hit, false);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("TREND_DOWN", h), laterDays: dn }).hit, true);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("TREND_DOWN", h), laterDays: up }).hit, false);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("RANGE", h), laterDays: flat }).hit, true);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("RANGE", h), laterDays: up }).hit, false);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("BREAK_RISK_UP", h), laterDays: up }).hit, true);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("BREAK_RISK_UP", h), laterDays: flat }).hit, false);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("BREAK_RISK_DOWN", h), laterDays: dn }).hit, true);
  assert.equal(evaluateOutlookOutcome({ outlook: OUT("BREAK_RISK_DOWN", h), laterDays: flat }).hit, false);
  const ins = evaluateOutlookOutcome({ outlook: OUT("INSUFFICIENT_DATA", h), laterDays: up });
  assert.equal(ins.hit, null);
  assert.equal(ins.status, "NOT_MEASURED");
  assert.match(ins.reason, /not measured/);
  assert.match(evaluateOutlookOutcome({ outlook: OUT("RANGE", h), laterDays: flat }).rule, /every daily spot close/);
});

// ─────────────────────────── API handler ───────────────────────────
function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}

function fakeStore(map) {
  const calls = { mget: [], writes: 0 };
  return {
    calls,
    mget: async (ks) => { calls.mget.push(ks); return ks.map((k) => (map.has(k) ? JSON.parse(JSON.stringify(map.get(k))) : null)); },
  };
}

const NOW_18_NOV = Date.UTC(2026, 10, 18, 4, 30); // Wed 18-Nov 10:00 IST

function apiMap() {
  const m = new Map();
  m.set(scKeys.day("2026-11-13"), scorecardDoc("2026-11-13"));
  m.set(swingKeys.day("2026-11-16"), day("2026-11-16", { close: 25400, near: chain({ expiry: "17-Nov-2026", spot: 25400, dte: 1, putWall: 25000, callWall: 25600 }) }));
  m.set(swingKeys.day("2026-11-17"), day("2026-11-17", { close: 25450, near: chain({ expiry: "24-Nov-2026", spot: 25450, dte: 7, putWall: 25200, callWall: 25700 }) }));
  m.set(scKeys.day("2026-11-17"), scorecardDoc("2026-11-17")); // ignored: a swing summary exists
  m.set(swingKeys.outlook("2026-11-16"), { asOf: "2026-11-16", regime: "RANGE", confidence: "LOW", reference: { spotClose: 25400 }, horizon: { expiry: "17-Nov-2026" }, expectedRange: { low: 25100, high: 25700, expiry: "17-Nov-2026" } });
  m.set(swingKeys.outlook("2026-11-17"), { asOf: "2026-11-17", regime: "TREND_UP", confidence: "LOW", reference: { spotClose: 25450 }, horizon: { expiry: "24-Nov-2026" }, expectedRange: { low: 25150, high: 25750, expiry: "24-Nov-2026" } });
  return m;
}

test("api/swing: merges swing days with scorecard-derived partial days, read-only", async () => {
  const store = fakeStore(apiMap());
  const h = createSwingHandler({ now: () => NOW_18_NOV, mget: store.mget, env: () => ({}) });
  const res = mockRes();
  await h({ method: "GET", query: { days: "10" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const b = res.body;
  assert.equal(b.ok, true);
  assert.equal(b.enabled, true);
  assert.deepEqual(b.days.map((d) => [d.date, d.source]), [["2026-11-13", "scorecard-series"], ["2026-11-16", "capture"], ["2026-11-17", "capture"]]);
  assert.equal(b.days[0].partial, true);
  assert.equal(b.asOf, "2026-11-17");
  assert.equal(b.outlook.daysUsed, 3);
  assert.equal(b.outlook.expectedRange.expiry, "24-Nov-2026");
  // weekend dates were never requested
  const requested = store.calls.mget.flat();
  assert.ok(!requested.some((k) => /2026-11-14|2026-11-15/.test(k)));
  // scorecard docs are only read for dates without a swing summary
  assert.ok(!store.calls.mget[1].includes(scKeys.day("2026-11-17")));
  // past outlooks + tally
  const p16 = b.pastOutlooks.find((p) => p.date === "2026-11-16");
  assert.equal(p16.outcome.status, "MEASURED");
  assert.equal(p16.outcome.horizonDate, "2026-11-17");
  assert.equal(p16.outcome.hit, true);
  const p17 = b.pastOutlooks.find((p) => p.date === "2026-11-17");
  assert.equal(p17.outcome.status, "PENDING");
  assert.deepEqual(b.tally.byRegime.RANGE, { n: 1, hits: 1, pending: 0 });
  assert.deepEqual(b.tally.byRegime.TREND_UP, { n: 0, hits: 0, pending: 1 });
});

test("api/swing: disabled switch, days clamped, method guard", async () => {
  const store = fakeStore(apiMap());
  const off = createSwingHandler({ now: () => NOW_18_NOV, mget: store.mget, env: () => ({ SWING_ENABLED: "false" }) });
  const r1 = mockRes();
  await off({ method: "GET", query: {} }, r1);
  assert.equal(r1.body.enabled, false);
  assert.equal(r1.body.outlook, null);
  assert.equal(store.calls.mget.length, 0);

  assert.equal(clampDays(undefined), 30);
  assert.equal(clampDays("abc"), 30);
  assert.equal(clampDays("-5"), 1);
  assert.equal(clampDays("0"), 1);
  assert.equal(clampDays("1000"), 120);
  assert.equal(clampDays("7"), 7);
  const on = createSwingHandler({ now: () => NOW_18_NOV, mget: store.mget, env: () => ({}) });
  const r2 = mockRes();
  await on({ method: "GET", query: { days: "100000" } }, r2);
  assert.equal(r2.body.daysRequested, 120);

  const r3 = mockRes();
  await on({ method: "POST", query: {}, body: {} }, r3);
  assert.equal(r3.statusCode, 405);
  const r4 = mockRes();
  await on({ method: "GET", query: {} }, r4);
  assert.equal(r4.body.ok, true);
});

test("api/swing: store failure answers a well-formed empty outlook", async () => {
  const h = createSwingHandler({ now: () => NOW_18_NOV, mget: async () => { throw new Error("down"); }, env: () => ({}) });
  const res = mockRes();
  await h({ method: "GET", query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outlook.regime, "INSUFFICIENT_DATA");
  assert.deepEqual(res.body.days, []);
});

// ─────────────────────────── capture guard + runner ───────────────────────────
const SWCFG = getSwingConfig({});
const G = (o = {}) => shouldCaptureSwing({ cfg: SWCFG, sessionKind: "WEEKDAY", isLiveMarket: true, istMinutes: 925, targetExpiry: "17-Nov-2026", nearExpiry: "17-Nov-2026", isEodTest: false, hasRedis: true, source: "poller", nowMs: 1000, deadlineMs: null, ...o });

test("swing config defaults and env overrides", () => {
  assert.deepEqual(
    { ...SWCFG },
    { enabled: true, captureStartMins: 920, captureEndMins: 940, captureEverySec: 300, retentionDays: 400, fetchTimeoutMs: 3500, minBudgetMs: 4500, maxCaptureMs: 5000, lookbackDays: 21, minLiveTicks: 30 },
  );
  assert.equal(getSwingConfig({ SWING_MIN_LIVE_TICKS: "10" }).minLiveTicks, 10);
  assert.equal(getSwingConfig({ SWING_MAX_CAPTURE_MS: "3000" }).maxCaptureMs, 3000);
  const c = getSwingConfig({ SWING_ENABLED: "false", SWING_CAPTURE_START: "15:30", SWING_CAPTURE_EVERY_SEC: "60", SWING_RETENTION_DAYS: "x" });
  assert.equal(c.enabled, false);
  assert.equal(c.captureStartMins, 930);
  assert.equal(c.captureEverySec, 60);
  assert.equal(c.retentionDays, 400);
  assert.equal(getSwingConfig({ SWING_CAPTURE_START: "25:00" }).captureStartMins, 920);
});

test("capture guard: window boundaries and every gate", () => {
  assert.equal(G({ istMinutes: 919 }).capture, false);
  assert.equal(G({ istMinutes: 920 }).capture, true);
  assert.equal(G({ istMinutes: 940 }).capture, true);
  assert.equal(G({ istMinutes: 941 }).capture, false);
  assert.equal(G({ cfg: { ...SWCFG, enabled: false } }).reason, "disabled");
  assert.equal(G({ hasRedis: false }).reason, "no-redis");
  assert.equal(G({ isEodTest: true }).reason, "eod-test");
  assert.equal(G({ source: "webhook-refresh" }).reason, "webhook-path");
  assert.equal(G({ sessionKind: "MUHURAT" }).capture, false);
  assert.equal(G({ sessionKind: "CLOSED", isLiveMarket: false }).capture, false);
  assert.equal(G({ isLiveMarket: false }).capture, false);
  assert.equal(G({ targetExpiry: "24-Nov-2026" }).reason, "non-near-target");
  assert.equal(G({ source: "browser" }).capture, true);
});

test("capture guard: time budget — low budget still captures (near chain only), no budget skips", () => {
  const ok = G({ nowMs: 1000, deadlineMs: 1000 + 4500 });
  assert.deepEqual([ok.capture, ok.fetchExtras], [true, true]);
  const low = G({ nowMs: 1000, deadlineMs: 1000 + 4499 });
  assert.deepEqual([low.capture, low.fetchExtras, low.reason], [true, false, "low-budget-near-chain-only"]);
  const none = G({ nowMs: 1000, deadlineMs: 1000 });
  assert.equal(none.capture, false);
  const noDeadline = G({ deadlineMs: null });
  assert.equal(noDeadline.fetchExtras, true);
});

test("planExtraChains: skip equal expiries, reuse the expiry-day prefetch, honour the budget", () => {
  const p = planExtraChains({ nearExpiry: "17-Nov-2026", nextExpiry: "24-Nov-2026", monthlyExpiry: "24-Nov-2026" });
  assert.equal(p.nextWeekly.action, "fetch");
  assert.equal(p.monthly.action, "same-as-next");
  assert.equal(planExtraChains({ nearExpiry: "24-Nov-2026", nextExpiry: "01-Dec-2026", monthlyExpiry: "24-Nov-2026" }).monthly.action, "same-as-near");
  assert.equal(planExtraChains({ nearExpiry: "17-Nov-2026", nextExpiry: "24-Nov-2026", monthlyExpiry: "29-Dec-2026", hasPrefetchedNext: true }).nextWeekly.action, "reuse-prefetched");
  const low = planExtraChains({ nearExpiry: "17-Nov-2026", nextExpiry: "24-Nov-2026", monthlyExpiry: "29-Dec-2026", fetchExtras: false });
  assert.equal(low.nextWeekly.action, "skip");
  assert.equal(low.monthly.action, "skip");
  assert.equal(planExtraChains({ nearExpiry: "17-Nov-2026", nextExpiry: "17-Nov-2026", monthlyExpiry: "" }).nextWeekly.action, "skip");
});

function captureDeps({ lock = true, fetchImpl = null } = {}) {
  const writes = new Map();
  const fetched = [];
  return {
    writes, fetched,
    deps: {
      now: () => Date.UTC(2026, 10, 16, 10, 5),
      dteOf: (e) => dteFromExpiry(e, Date.UTC(2026, 10, 16, 10, 5)),
      claimLock: async () => lock,
      set: async (k, v) => { writes.set(k, JSON.parse(JSON.stringify(v))); return true; },
      mget: async (ks) => ks.map(() => null),
      fetchChain: async (expiry, ms) => {
        fetched.push([expiry, ms]);
        if (fetchImpl) return fetchImpl(expiry);
        return { rows: rows(25100), spot: 25100 };
      },
    },
  };
}
const CTX = { date: "2026-11-16", spot: 25100, nearExpiry: "17-Nov-2026", nextExpiry: "24-Nov-2026", monthlyExpiry: "29-Dec-2026", nearRows: rows(25100), prefetchedNextRows: null, timeline: syntheticTimeline(), futuresMetrics: null, dataQuality: { coveragePct: 95 }, nearIntraday: { floor: 25000, roof: 25200, pcr: 1.1, deltaPcr: 1.2, totalPutWriting: 5, totalCallWriting: 4 } };

test("runSwingCapture: insufficient budget skips the extra fetches but still writes the summary from the near chain", async () => {
  const c = captureDeps();
  const r = await runSwingCapture({ cfg: SWCFG, ctx: CTX, deps: c.deps, fetchExtras: false, env: {} });
  assert.equal(r.status, "CAPTURED");
  assert.equal(c.fetched.length, 0);
  const s = c.writes.get(swingKeys.day("2026-11-16"));
  assert.equal(s.chains.near.expiry, "17-Nov-2026");
  assert.equal(s.chains.nextWeekly, null);
  assert.ok(s.notes.some((n) => /not enough time/.test(n)));
  assert.ok(c.writes.has(swingKeys.outlook("2026-11-16")));
});

test("runSwingCapture: fetches next weekly + monthly in parallel; a failed fetch leaves null with a note", async () => {
  const c = captureDeps({ fetchImpl: (e) => { if (e === "29-Dec-2026") throw new Error("HTTP 403"); return { rows: rows(25100), spot: 25100 }; } });
  const r = await runSwingCapture({ cfg: SWCFG, ctx: CTX, deps: c.deps, fetchExtras: true, env: {} });
  assert.equal(r.status, "CAPTURED");
  assert.deepEqual(c.fetched.map((f) => f[0]).sort(), ["24-Nov-2026", "29-Dec-2026"]);
  assert.ok(c.fetched.every((f) => f[1] === 3500));
  const s = c.writes.get(swingKeys.day("2026-11-16"));
  assert.equal(s.chains.nextWeekly.expiry, "24-Nov-2026");
  assert.equal(s.chains.monthly, null);
  assert.ok(s.notes.some((n) => /monthly chain \(29-Dec-2026\) fetch failed: HTTP 403/.test(n)));
});

test("runSwingCapture: expiry-day prefetch reused, monthly equal to next not fetched; throttled lock writes nothing", async () => {
  const c = captureDeps();
  await runSwingCapture({ cfg: SWCFG, ctx: { ...CTX, monthlyExpiry: "24-Nov-2026", prefetchedNextRows: rows(25100) }, deps: c.deps, fetchExtras: true, env: {} });
  assert.equal(c.fetched.length, 0);
  const s = c.writes.get(swingKeys.day("2026-11-16"));
  assert.equal(s.chains.nextWeekly.expiry, "24-Nov-2026");
  assert.deepEqual(s.chains.monthly, s.chains.nextWeekly);
  const t = captureDeps({ lock: false });
  const r = await runSwingCapture({ cfg: SWCFG, ctx: CTX, deps: t.deps, fetchExtras: true, env: {} });
  assert.equal(r.status, "THROTTLED");
  assert.equal(t.writes.size, 0);
  const e = await runSwingCapture({ cfg: SWCFG, ctx: CTX, deps: { ...c.deps, claimLock: async () => { throw new Error("redis down"); } }, env: {} });
  assert.equal(e.status, "ERROR");
});

test("loadSwingHistory: prefers swing summaries, falls back to scorecard docs, skips empty", async () => {
  const store = fakeStore(apiMap());
  const h = await loadSwingHistory({ mget: store.mget, dates: ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-12"], includeOutlooks: true });
  assert.deepEqual(h.days.map((d) => d.date), ["2026-11-13", "2026-11-16", "2026-11-17"]);
  assert.equal(h.outlooks.length, 2);
});

// ─────────────────────────── non-interference with the refresh core ───────────────────────────
// Wed 11-Nov-2026 15:25 IST (09:55 UTC): inside the capture window, not an expiry day.
const CAPTURE_TIME = Date.UTC(2026, 10, 11, 9, 55, 0);

function pricedChain(spot) {
  const out = [];
  for (let k = spot - 500; k <= spot + 500; k += 50) {
    out.push({
      strikePrice: k,
      PE: { changeinOpenInterest: k <= spot ? 4000 : 500, openInterest: 50000 + (k === spot - 300 ? 400000 : 0), lastPrice: Math.max(1, 120 + (k - spot) * 0.5) },
      CE: { changeinOpenInterest: k >= spot ? 3000 : 400, openInterest: 50000 + (k === spot + 300 ? 500000 : 0), lastPrice: Math.max(1, 120 - (k - spot) * 0.5) },
    });
  }
  return out;
}

function makeRefreshFetch() {
  const swingWrites = {};
  const nseUrls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
    if (u.startsWith(FAKE_REDIS)) {
      if (init.method === "POST" && init.body) {
        const cmd = JSON.parse(init.body);
        const key = String(cmd[1] || "");
        if (key.startsWith("nifty:swing:")) {
          if (cmd[0] === "SET") { swingWrites[key] = cmd[2]; return json({ result: "OK" }); }
        }
        if (cmd[0] === "MGET") return json({ result: cmd.slice(1).map(() => null) });
      }
      const m = u.match(/\/set\/([^?]+)/);
      if (m) return json({ result: "OK" });
      return json({ result: null });
    }
    nseUrls.push(u);
    if (u === "https://www.nseindia.com/option-chain") return new Response("ok", { status: 200, headers: { "set-cookie": "nsit=abc; Path=/" } });
    if (u.includes("option-chain-contract-info")) return json({ expiryDates: ["17-Nov-2026", "24-Nov-2026", "01-Dec-2026", "29-Dec-2026"] });
    if (u.includes("option-chain-v3")) {
      const data = pricedChain(25000);
      return json({ records: { underlyingValue: 25000, timestamp: "11-Nov-2026 15:25:00", data }, filtered: { data } });
    }
    if (u.includes("liveEquity-derivatives")) return json({ data: [] });
    return json({ result: null });
  };
  return { fn, swingWrites, nseUrls };
}

async function runRefresh({ env = {}, override = undefined, opts = {} } = {}) {
  const realFetch = globalThis.fetch;
  const f = makeRefreshFetch();
  globalThis.fetch = f.fn;
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  mock.timers.enable({ apis: ["Date"], now: CAPTURE_TIME });
  nifty.__resetSessionStateForTests();
  if (override !== undefined) nifty.__setSwingCaptureForTests(override);
  try {
    const r = await nifty.refreshLiveSnapshot({ queryExpiry: "near", awaitPersist: true, source: "poller", deadlineMs: Date.now() + 12000, ...opts });
    return { r, f };
  } finally {
    nifty.__setSwingCaptureForTests(null);
    mock.timers.reset();
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    nifty.__resetSessionStateForTests();
  }
}

test("non-interference: payload identical with the capture on and off; capture writes only nifty:swing:*", async () => {
  // Warm-up: the floor/roof "previous reading" is module state that __resetSessionStateForTests
  // does not clear, so the first refresh in a process words floorShift differently.
  await runRefresh({ env: { SWING_ENABLED: "false" } });
  const off = await runRefresh({ env: { SWING_ENABLED: "false" } });
  const on = await runRefresh({ env: { SWING_ENABLED: "true" } });
  assert.equal(off.r.ok, true, off.r.error);
  assert.equal(on.r.ok, true, on.r.error);
  assert.deepEqual(JSON.parse(JSON.stringify(on.r.payload)), JSON.parse(JSON.stringify(off.r.payload)));
  for (const k of ["ok", "persisted", "snapshotAt", "targetExpiry", "nearExpiry", "ticks"]) assert.deepEqual(on.r[k], off.r[k], k);
  assert.equal(Object.keys(off.f.swingWrites).length, 0);
  const day11 = JSON.parse(on.f.swingWrites["nifty:swing:day:2026-11-11"]);
  assert.equal(day11.date, "2026-11-11");
  assert.equal(day11.chains.near.expiry, "17-Nov-2026");
  assert.equal(day11.chains.near.callWall, 25300);
  assert.equal(day11.chains.near.putWall, 24700);
  assert.equal(day11.chains.nextWeekly.expiry, "24-Nov-2026");
  // On 11-Nov the monthly expiry is 24-Nov (the next weekly): reused, not fetched twice.
  assert.deepEqual(day11.chains.monthly, day11.chains.nextWeekly);
  const v3Calls = (u) => u.filter((x) => x.includes("option-chain-v3"));
  assert.equal(v3Calls(on.f.nseUrls).length, v3Calls(off.f.nseUrls).length + 1);
  assert.ok(on.f.swingWrites["nifty:swing:outlook:2026-11-11"]);
  assert.deepEqual(Object.keys(on.f.swingWrites).sort(), ["nifty:swing:capture_lock", "nifty:swing:day:2026-11-11", "nifty:swing:outlook:2026-11-11"]);
});

test("non-interference: a throwing or rejecting swing capture does not fail the refresh", async () => {
  const base = await runRefresh({ env: { SWING_ENABLED: "false" } });
  const sync = await runRefresh({ override: () => { throw new Error("boom"); } });
  const async_ = await runRefresh({ override: async () => { throw new Error("boom"); } });
  for (const x of [sync, async_]) {
    assert.equal(x.r.ok, true);
    assert.equal(x.r.persisted, true);
    assert.deepEqual(JSON.parse(JSON.stringify(x.r.payload)), JSON.parse(JSON.stringify(base.r.payload)));
  }
});

test("non-interference: non-awaited callers (browser) never wait for the capture", async () => {
  let called = 0;
  const never = () => { called += 1; return new Promise(() => {}); };
  const x = await runRefresh({ override: never, opts: { awaitPersist: false, source: "browser", deadlineMs: null } });
  assert.equal(x.r.ok, true);
  assert.equal(called, 1);
});

test("non-interference: webhook-refresh path never captures", async () => {
  const x = await runRefresh({ env: { SWING_ENABLED: "true" }, opts: { source: "webhook-refresh" } });
  assert.equal(x.r.ok, true);
  assert.equal(Object.keys(x.f.swingWrites).length, 0);
});
