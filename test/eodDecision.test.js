import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateEODDecision,
  calculateDeltaPcr,
  DEFAULT_EOD_SEED_HISTORY
} from "../api/nifty-oi.js";

test("calculateDeltaPcr handles normal, negative, and zero call writing safely", () => {
  // Normal writing
  assert.equal(calculateDeltaPcr(200000, 100000), 2.0);
  assert.equal(calculateDeltaPcr(50000, 100000), 0.5);

  // Call unwinding (short covering) with active put writing -> heavily bullish delta
  assert.equal(calculateDeltaPcr(150000, -20000), 2.5);
  assert.equal(calculateDeltaPcr(100000, 0), 2.5);

  // Put unwinding with active call writing -> heavily bearish delta
  assert.equal(calculateDeltaPcr(-15000, 120000), 0.35);
  assert.equal(calculateDeltaPcr(0, 80000), 0.35);
});

test("calculateEODDecision gives PCR +1 pt during bullish expansion without overbought crowding", () => {
  const result = calculateEODDecision({
    spot: 24200,
    floorStrike: 24100,
    roofStrike: 24350,
    totPutWriting: 250000,
    totCallWriting: 140000,
    pcr: 1.25,
    deltaPcr: 1.55,
    timeline: [
      { minutes: 855, netDiff: 10000 },
      { minutes: 900, netDiff: 35000 },
      { minutes: 915, netDiff: 45000 }
    ],
    dayOfWeek: 3, // Wednesday
    nowMins: 915,
  });

  const pcrAudit = result.audit.find(a => a.label === "PCR Structure");
  assert.equal(pcrAudit.status, "BULLISH");
  assert.equal(pcrAudit.impact, "+1 pt");
  assert.equal(result.pcrWarning, null);
  assert.equal(result.verdict, "CARRY NIFTY CE (BTST)");
  assert.ok(result.score >= 3);
});

test("calculateEODDecision gives PCR -1 pt during bearish compression without oversold exhaustion", () => {
  const result = calculateEODDecision({
    spot: 24180,
    floorStrike: 24100,
    roofStrike: 24300,
    totPutWriting: 80000,
    totCallWriting: 220000,
    pcr: 0.82,
    deltaPcr: 0.55,
    timeline: [
      { minutes: 855, netDiff: -10000 },
      { minutes: 900, netDiff: -35000 },
      { minutes: 915, netDiff: -45000 }
    ],
    dayOfWeek: 4, // Thursday
    nowMins: 915,
  });

  const pcrAudit = result.audit.find(a => a.label === "PCR Structure");
  assert.equal(pcrAudit.status, "BEARISH");
  assert.equal(pcrAudit.impact, "-1 pt");
  assert.equal(result.pcrWarning, null);
  assert.equal(result.verdict, "CARRY NIFTY PE (STBT)");
  assert.ok(result.score <= -3);
});

test("calculateEODDecision flags EXTREME OVERBOUGHT warning and does NOT award blind bullish points at PCR >= 1.40", () => {
  const result = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 300000,
    totCallWriting: 100000,
    pcr: 1.52, // Extreme overbought
    deltaPcr: 2.10,
    timeline: [
      { minutes: 855, netDiff: 20000 },
      { minutes: 900, netDiff: 50000 },
      { minutes: 915, netDiff: 55000 }
    ],
    dayOfWeek: 2,
    nowMins: 915,
  });

  const pcrAudit = result.audit.find(a => a.label === "PCR Structure");
  assert.equal(pcrAudit.status, "EXTREME_OVERBOUGHT");
  assert.equal(pcrAudit.impact, "⚠️ Warning (0 pts)");
  assert.ok(result.pcrWarning.includes("EXTREME OVERBOUGHT"));
  assert.ok(result.action.includes("EXTREME OVERBOUGHT"));
});

test("calculateEODDecision flags EXTREME OVERSOLD warning and does NOT award blind bearish points at PCR <= 0.65", () => {
  const result = calculateEODDecision({
    spot: 24100,
    floorStrike: 24000,
    roofStrike: 24200,
    totPutWriting: 60000,
    totCallWriting: 250000,
    pcr: 0.58, // Deeply oversold
    deltaPcr: 0.35,
    timeline: [
      { minutes: 855, netDiff: -20000 },
      { minutes: 900, netDiff: -50000 },
      { minutes: 915, netDiff: -55000 }
    ],
    dayOfWeek: 1,
    nowMins: 915,
  });

  const pcrAudit = result.audit.find(a => a.label === "PCR Structure");
  assert.equal(pcrAudit.status, "EXTREME_OVERSOLD");
  assert.equal(pcrAudit.impact, "⚠️ Warning (0 pts)");
  assert.ok(result.pcrWarning.includes("DEEPLY OVERSOLD"));
  assert.ok(result.action.includes("DEEPLY OVERSOLD"));
});

test("calculateEODDecision enforces Friday 4-point risk rule and 50% sizing limit", () => {
  // Score +2 on a Friday (insufficient for weekend carry)
  const result = calculateEODDecision({
    spot: 24110, // Breakdown near floor -> -1
    floorStrike: 24100,
    roofStrike: 24300,
    totPutWriting: 200000,
    totCallWriting: 100000, // +2
    pcr: 1.22,
    deltaPcr: 1.45, // +1
    timeline: [], // 0
    dayOfWeek: 5, // Friday!
    nowMins: 915,
  });

  assert.equal(result.isFriday, true);
  // Score is 2 (less than Friday threshold 4)
  assert.equal(result.verdict, "EXIT TO CASH / DO NOT CARRY");
  assert.ok(result.action.includes("Friday weekend alert"));
});

test("DEFAULT_EOD_SEED_HISTORY provides multi-session track record with verified win metrics", () => {
  assert.ok(Array.isArray(DEFAULT_EOD_SEED_HISTORY));
  assert.ok(DEFAULT_EOD_SEED_HISTORY.length >= 10);

  const carried = DEFAULT_EOD_SEED_HISTORY.filter(h => h.verdict.includes("BTST") || h.verdict.includes("STBT"));
  const wins = carried.filter(h => h.outcome === "WIN");
  const winRate = (wins.length / carried.length) * 100;

  assert.ok(winRate >= 75, `Expected win rate >= 75%, got ${winRate}%`);
  assert.ok(DEFAULT_EOD_SEED_HISTORY.some(h => h.outcome === "PRESERVED_CASH"));
});
