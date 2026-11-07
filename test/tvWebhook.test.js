import test from "node:test";
import assert from "node:assert/strict";
import { fuseChartWithOptionChain, getIstDateString } from "../api/tv-webhook.js";

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
