import test from "node:test";
import assert from "node:assert/strict";
import { fuseChartWithOptionChain, getIstDateString, evaluateActiveTradeLifecycle } from "../api/tv-webhook.js";

test("getIstDateString returns YYYY-MM-DD format", () => {
  const d = getIstDateString();
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
});

test("fuseChartWithOptionChain: BEAR_TRAP_BUY approved with 2 Lots when Put Blitz + near Floor", () => {
  const tv = {
    sym: "NSE:NIFTY",
    tf: "15",
    dir: "LONG",
    grade: "BEAR_TRAP_BUY",
    close: 25015,
    sl: 24965,
    actFloor: 25000,
    actRoof: 25200,
    futQuad: "LONG_UNWINDING",
    futOiPct: -1.2,
    futOiSrc: "REAL_1_2",
    score: 6,
  };

  const liveScanner = {
    deltaPcr: 1.45,
    floor: 25000,
    roof: 25200,
    futures: { quadrant: "LONG_UNWINDING" },
    smartMoneyFusion: { primaryScenario: "BEAR_TRAP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "EXECUTE_TIER1_SCOUT");
  assert.equal(res.recommendedLots, 2);
  assert.equal(res.tier, "TIER_1_SCOUT");
  assert.equal(res.entryPrice, 25015);
  assert.equal(res.stopLoss, 24965);
  assert.equal(res.riskPoints, 50);
});

test("fuseChartWithOptionChain: BEAR_TRAP_BUY VETOED (0 Lots) when real Option Chain shows Call Blitz + Short Buildup", () => {
  const tv = {
    sym: "NSE:NIFTY",
    tf: "15",
    dir: "LONG",
    grade: "BEAR_TRAP_BUY",
    close: 24980,
    sl: 24940,
    actFloor: 25000,
    futQuad: "SHORT_BUILDUP",
  };

  const liveScanner = {
    deltaPcr: 0.42, // Severe opposite Call Writing blitz
    floor: 25000,
    roof: 25200,
    futures: { quadrant: "SHORT_BUILDUP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "VETO_SIGNAL");
  assert.equal(res.recommendedLots, 0);
  assert.match(res.reasoning, /VETOED.*heavy Call Writing/);
});

test("fuseChartWithOptionChain: BULL_TRAP_SELL approved with 2 Lots when Call Blitz + near Roof", () => {
  const tv = {
    sym: "NSE:NIFTY",
    tf: "15",
    dir: "SHORT",
    grade: "BULL_TRAP_SELL",
    close: 25185,
    sl: 25225,
    actFloor: 25000,
    actRoof: 25200,
    futQuad: "SHORT_COVERING",
    futOiPct: -2.1,
    futOiSrc: "REAL_1_2",
  };

  const liveScanner = {
    corridor: {
      deltaPCR: 0.65,
      floorStrike: 25000,
      roofStrike: 25200,
    },
    futures: { quadrant: "SHORT_COVERING" },
    smartMoneyFusion: { primaryScenario: "BULL_TRAP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "EXECUTE_TIER1_SCOUT");
  assert.equal(res.recommendedLots, 2);
  assert.equal(res.tier, "TIER_1_SCOUT");
  assert.equal(res.entryPrice, 25185);
  assert.equal(res.stopLoss, 25225);
  assert.equal(res.riskPoints, 40);
});

test("fuseChartWithOptionChain: BULL_TRAP_SELL VETOED (0 Lots) when real Option Chain shows heavy Put Blitz + Long Buildup", () => {
  const tv = {
    sym: "NSE:NIFTY",
    tf: "15",
    dir: "SHORT",
    grade: "BULL_TRAP_SELL",
    close: 25210,
    sl: 25250,
  };

  const liveScanner = {
    deltaPcr: 1.75, // Severe Put Underwriting
    futures: { quadrant: "LONG_BUILDUP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "VETO_SIGNAL");
  assert.equal(res.recommendedLots, 0);
  assert.match(res.reasoning, /VETOED.*aggressive Put Writing/);
});

test("fuseChartWithOptionChain: Tier-2 SWING_BOTTOM adds 2 Lots when Bullish Synergy aligns", () => {
  const tv = {
    sym: "NSE:NIFTY",
    tf: "15",
    dir: "LONG",
    grade: "SWING_BOTTOM",
    close: 25050,
    sl: 24980,
    score: 7,
  };

  const liveScanner = {
    deltaPcr: 1.48,
    smartMoneyFusion: { primaryScenario: "BULLISH_SYNERGY" },
    futures: { quadrant: "LONG_BUILDUP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "EXECUTE_TIER2_ADD");
  assert.equal(res.recommendedLots, 2);
  assert.equal(res.tier, "TIER_2_CONFIRMED_ADD");
});

test("fuseChartWithOptionChain: Tier-2 SWING_BOTTOM downgraded to Scalp (1 Lot, no BTST) if VETO_BTST active", () => {
  const tv = {
    sym: "NSE:NIFTY",
    tf: "15",
    dir: "LONG",
    grade: "SWING_BOTTOM",
    close: 25050,
    sl: 24980,
  };

  const liveScanner = {
    deltaPcr: 0.52,
    smartMoneyFusion: {
      actionTag: "VETO_BTST",
      primaryScenario: "BULL_TRAP",
    },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "DOWNGRADE_TO_SCALP");
  assert.equal(res.recommendedLots, 1);
  assert.match(res.reasoning, /Cap at 1 intraday lot; do not hold BTST/);
});

test("fuseChartWithOptionChain: Standard Intraday SIGNAL awards 2 Lots on Score >= 7, 1 Lot on normal score", () => {
  const tvHigh = {
    dir: "LONG",
    grade: "SIGNAL",
    close: 25030,
    score: 8,
  };
  const tvMid = {
    dir: "LONG",
    grade: "SIGNAL",
    close: 25030,
    score: 5,
  };

  const normalScanner = { deltaPcr: 1.10 };

  const resHigh = fuseChartWithOptionChain(tvHigh, normalScanner);
  assert.equal(resHigh.decision, "EXECUTE_INTRADAY");
  assert.equal(resHigh.recommendedLots, 2);

  const resMid = fuseChartWithOptionChain(tvMid, normalScanner);
  assert.equal(resMid.decision, "EXECUTE_INTRADAY");
  assert.equal(resMid.recommendedLots, 1);
});

test("fuseChartWithOptionChain: Non-trap signal with null/0 SL produces null stopLoss and targets (no fake stops)", () => {
  const tv = {
    dir: "LONG",
    grade: "MEGA",
    close: 25050,
    sl: 0,
    cappedSl: null,
    rDist: null,
    t1Dist: null,
    t2Dist: null,
    t1: null,
    t2: null,
  };

  const res = fuseChartWithOptionChain(tv, null);
  assert.equal(res.stopLoss, null);
  assert.equal(res.riskPoints, null);
  assert.equal(res.target1Price, null);
  assert.equal(res.target2Price, null);
  assert.equal(res.target1Dist, null);
  assert.equal(res.target2Dist, null);
});

test("fuseChartWithOptionChain: BEAR_TRAP_BUY preserves exact cappedSl, rDist, and fill-relative targets", () => {
  const tv = {
    dir: "LONG",
    grade: "BEAR_TRAP_BUY",
    close: 25064,
    sl: 24980,
    cappedSl: 25000,
    rDist: 64,
    t1Dist: 64,
    t2Dist: 128,
    t1: 25128,
    t2: 25192,
  };

  const res = fuseChartWithOptionChain(tv, null);
  assert.equal(res.decision, "EXECUTE_TIER1_SCOUT");
  assert.equal(res.entryPrice, 25064);
  assert.equal(res.stopLoss, 25000);
  assert.equal(res.riskPoints, 64);
  assert.equal(res.target1Price, 25128);
  assert.equal(res.target2Price, 25192);
  assert.equal(res.target1Dist, 64);
  assert.equal(res.target2Dist, 128);
});

test("fuseChartWithOptionChain: Guards against inverted Stop Loss for SHORT trades (SL must be above entry)", () => {
  const tv = {
    dir: "SHORT",
    grade: "SYNERGY_BEAR",
    close: 24932.6,
    sl: 24875.04, // Inverted: below entry price!
    cappedSl: 24875.04,
    rDist: 57.56,
    t1Dist: 57.56,
    t2Dist: 115.12,
  };

  const res = fuseChartWithOptionChain(tv, null);
  // Stop loss must be above entry for a short trade!
  assert.ok(res.stopLoss > res.entryPrice, `Expected stopLoss (${res.stopLoss}) > entryPrice (${res.entryPrice})`);
  assert.equal(res.stopLoss, 24990.16); // 24932.6 + 57.56
  assert.equal(res.target1Price, 24875.04); // 24932.6 - 57.56
  assert.equal(res.target2Price, 24817.48); // 24932.6 - 115.12
});

test("fuseChartWithOptionChain: SYNERGY_BEAR verified with High Conviction (2 Lots) when Call Blitz aligns", () => {
  const tv = {
    dir: "SHORT",
    grade: "SYNERGY_BEAR",
    close: 25150,
    sl: 25215,
    cappedSl: 25215,
    rDist: 65,
    actRoof: 25200,
    actFloor: 25000,
  };

  const liveScanner = {
    corridor: {
      deltaPCR: 0.62,
      floorStrike: 25000,
      roofStrike: 25200,
    },
    smartMoneyFusion: { primaryScenario: "HIGH_CONVICTION_BEARISH_SYNERGY" },
    futures: { quadrant: "SHORT_BUILDUP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(res.recommendedLots, 2);
  assert.equal(res.tier, "HIGH_CONVICTION_SYNERGY");
  assert.match(res.reasoning, /HIGH CONVICTION BEAR SYNERGY VERIFIED/);
});

test("fuseChartWithOptionChain: SYNERGY_BEAR VETOED (0 Lots) when real Option Chain shows Put Writing / Floor Defense (Nov 9 Scenario)", () => {
  const tv = {
    dir: "SHORT",
    grade: "SYNERGY_BEAR",
    close: 25035, // Near floor 25000
    sl: 25100,
    cappedSl: 25100,
    rDist: 65,
    actFloor: 25000,
  };

  // Exactly Nov 9 market state: ΔPCR=1.07, defending 25000 floor
  const liveScanner = {
    corridor: {
      deltaPCR: 1.07,
      floorStrike: 25000,
      roofStrike: 25200,
    },
    futures: { quadrant: "LONG_UNWINDING" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "VETO_DIVERGENT_SYNERGY");
  assert.equal(res.recommendedLots, 0);
  assert.match(res.reasoning, /VETOED.*Floor defense near 25000/);
});

test("fuseChartWithOptionChain: SYNERGY_BULL verified with High Conviction (2 Lots) when Put Blitz aligns", () => {
  const tv = {
    dir: "LONG",
    grade: "SYNERGY_BULL",
    close: 25060,
    sl: 24995,
    cappedSl: 24995,
    rDist: 65,
    actRoof: 25300,
    actFloor: 25000,
  };

  const liveScanner = {
    corridor: {
      deltaPCR: 1.42,
      floorStrike: 25000,
      roofStrike: 25300,
    },
    smartMoneyFusion: { primaryScenario: "HIGH_CONVICTION_BULLISH_SYNERGY" },
    futures: { quadrant: "LONG_BUILDUP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(res.recommendedLots, 2);
  assert.equal(res.tier, "HIGH_CONVICTION_SYNERGY");
  assert.match(res.reasoning, /HIGH CONVICTION BULL SYNERGY VERIFIED/);
});

test("fuseChartWithOptionChain: SYNERGY_BULL VETOED (0 Lots) when real Option Chain shows Call Writing resistance", () => {
  const tv = {
    dir: "LONG",
    grade: "SYNERGY_BULL",
    close: 25120,
    sl: 25055,
    cappedSl: 25055,
    rDist: 65,
  };

  const liveScanner = {
    corridor: {
      deltaPCR: 0.65, // Real Call Blitz, not Put Blitz!
      floorStrike: 25000,
      roofStrike: 25200,
    },
    futures: { quadrant: "SHORT_BUILDUP" },
  };

  const res = fuseChartWithOptionChain(tv, liveScanner);
  assert.equal(res.decision, "VETO_DIVERGENT_SYNERGY");
  assert.equal(res.recommendedLots, 0);
  assert.match(res.reasoning, /VETOED.*Call Writing resistance/);
});

test("evaluateActiveTradeLifecycle: Long trade triggers T1, moves SL to cost", async () => {
  const trade = {
    active: true,
    grade: "BEAR_TRAP_BUY",
    direction: "LONG",
    entryPrice: 24908,
    target1Price: 25045,
    target2Price: 25182,
    stopLoss: 24771,
    riskPoints: 137,
    target1Dist: 137,
    target2Dist: 274,
    hitT1: false,
  };

  let store = { "nifty:tv:active_trade": JSON.stringify(trade) };
  let list = [];
  const mockRedis = {
    async get(k) { return store[k] || null; },
    async set(k, v) { store[k] = v; return "OK"; },
    async del(k) { delete store[k]; return 1; },
    async lpush(k, v) { list.unshift(v); return list.length; },
  };

  const res = await evaluateActiveTradeLifecycle(25050, 25055, 24908, mockRedis);
  assert.equal(res?.event, "TARGET_1_HIT");
  assert.equal(res?.activeTrade.hitT1, true);
  assert.equal(res?.activeTrade.stopLoss, 24908); // SL moved to cost!
  assert.equal(res?.activeTrade.slAtCost, true);
  assert.equal(list.length, 1);
});

test("evaluateActiveTradeLifecycle: Long trade after T1 triggers Breakeven exit at cost", async () => {
  const trade = {
    active: true,
    grade: "BEAR_TRAP_BUY",
    direction: "LONG",
    entryPrice: 24908,
    target1Price: 25045,
    target2Price: 25182,
    stopLoss: 24908, // At cost
    riskPoints: 137,
    target1Dist: 137,
    target2Dist: 274,
    hitT1: true,
    slAtCost: true,
  };

  let store = { "nifty:tv:active_trade": JSON.stringify(trade) };
  let list = [];
  const mockRedis = {
    async get(k) { return store[k] || null; },
    async set(k, v) { store[k] = v; return "OK"; },
    async del(k) { delete store[k]; return 1; },
    async lpush(k, v) { list.unshift(v); return list.length; },
  };

  const res = await evaluateActiveTradeLifecycle(24890, 25050, 24889, mockRedis);
  assert.equal(res?.event, "BREAKEVEN_STOP");
  assert.equal(res?.exitRecord.exitReason, "BREAKEVEN_STOP");
  assert.equal(res?.exitRecord.exitPrice, 24908);
  assert.ok(res?.exitRecord.netPnl > 70); // 137 * 0.6 - 4 = ~78.2 pts profit
  assert.equal(store["nifty:tv:active_trade"], undefined); // Position closed & deleted!
  assert.equal(list.length, 1);
});

test("evaluateActiveTradeLifecycle: Long trade triggers Target 2 full profit exit", async () => {
  const trade = {
    active: true,
    grade: "BEAR_TRAP_BUY",
    direction: "LONG",
    entryPrice: 24908,
    target1Price: 25045,
    target2Price: 25182,
    stopLoss: 24908,
    riskPoints: 137,
    target1Dist: 137,
    target2Dist: 274,
    hitT1: true,
  };

  let store = { "nifty:tv:active_trade": JSON.stringify(trade) };
  let list = [];
  const mockRedis = {
    async get(k) { return store[k] || null; },
    async set(k, v) { store[k] = v; return "OK"; },
    async del(k) { delete store[k]; return 1; },
    async lpush(k, v) { list.unshift(v); return list.length; },
  };

  const res = await evaluateActiveTradeLifecycle(25190, 25195, 25000, mockRedis);
  assert.equal(res?.event, "TARGET_2_HIT");
  assert.equal(res?.exitRecord.exitReason, "TARGET_2_HIT");
  assert.equal(store["nifty:tv:active_trade"], undefined); // Trade closed!
});

test("evaluateActiveTradeLifecycle: Long trade hits initial SL before T1", async () => {
  const trade = {
    active: true,
    grade: "BEAR_TRAP_BUY",
    direction: "LONG",
    entryPrice: 24908,
    target1Price: 25045,
    target2Price: 25182,
    stopLoss: 24771,
    riskPoints: 137,
    target1Dist: 137,
    target2Dist: 274,
    hitT1: false,
  };

  let store = { "nifty:tv:active_trade": JSON.stringify(trade) };
  let list = [];
  const mockRedis = {
    async get(k) { return store[k] || null; },
    async set(k, v) { store[k] = v; return "OK"; },
    async del(k) { delete store[k]; return 1; },
    async lpush(k, v) { list.unshift(v); return list.length; },
  };

  const res = await evaluateActiveTradeLifecycle(24760, 24908, 24750, mockRedis);
  assert.equal(res?.event, "STOP_LOSS_HIT");
  assert.equal(res?.exitRecord.exitReason, "STOP_LOSS_HIT");
  assert.equal(store["nifty:tv:active_trade"], undefined);
});
