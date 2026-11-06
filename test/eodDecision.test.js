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


test("calculateEODDecision awards ±3 pts for dominant 14:15+ institutional flow", () => {
  const result = calculateEODDecision({
    spot: 24200,
    floorStrike: 24100,
    roofStrike: 24350,
    totPutWriting: 100000,
    totCallWriting: 100000, // 0 pts full day
    pcr: 1.05,
    deltaPcr: 1.10, // 0 pts pcr
    timeline: [
      { minutes: 855, netDiff: 10000 },
      { minutes: 900, netDiff: 60000 },
      { minutes: 915, netDiff: 95000 } // +85,000 lots since 14:15 -> +3 pts!
    ],
    dayOfWeek: 3,
    nowMins: 915,
  });

  const closingAudit = result.audit.find(a => a.label === "Closing Hour Flow (14:15+)");
  assert.equal(closingAudit.status, "INSTITUTIONAL_PUT_BLITZ");
  assert.equal(closingAudit.impact, "+3 pts (Institutional Blitz)");
  assert.equal(result.verdict, "CARRY NIFTY CE (BTST)");
});

test("calculateEODDecision triggers LATE CALL BLITZ VETO and blocks BTST when smart money writes calls after 14:15 (Nov 5th scenario)", () => {
  // Scenario: Morning was bullish (+2 pts full day, +1 level), but after 14:15, > 1.2L CE was written (-85k netDiff)
  const result = calculateEODDecision({
    spot: 24536,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 300000,
    totCallWriting: 180000, // +2 pts on full day
    pcr: 1.34,
    deltaPcr: 0.95,
    timeline: [
      { minutes: 855, netDiff: 30000 }, // 14:15 IST
      { minutes: 900, netDiff: -20000 },
      { minutes: 915, netDiff: -65000 } // -95,000 delta since 14:15 (heavy CE writing)
    ],
    dayOfWeek: 4, // Thursday (yesterday)
    nowMins: 915,
  });

  // VETO must fire and BTST must be blocked
  assert.notEqual(result.verdict, "CARRY NIFTY CE (BTST)", "BTST must be blocked when late CE blitz occurs");
  assert.equal(result.verdict, "EXIT TO CASH / DO NOT CARRY");
  assert.equal(result.bias, "NEUTRAL");

  const vetoAudit = result.audit.find(a => a.label.includes("14:15+ Institutional Veto"));
  assert.ok(vetoAudit, "Audit must include 14:15+ Veto Guardrail");
  assert.equal(vetoAudit.status, "BEARISH_VETO");
  assert.ok(result.action.includes("LATE CALL BLITZ VETO"));
});


test("calculateEODDecision flags Tier 2 HISTORICAL_PEAK_OVERBOUGHT and penalizes -1 pt at PCR >= 1.65", () => {
  const result = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 300000,
    totCallWriting: 100000,
    pcr: 1.72, // 5-Year Extreme Peak (> 1.65)
    deltaPcr: 2.10,
    timeline: [],
    dayOfWeek: 2,
    nowMins: 915,
  });

  const pcrAudit = result.audit.find(a => a.label.includes("PCR Structure"));
  assert.equal(pcrAudit.status, "HISTORICAL_PEAK_OVERBOUGHT");
  assert.equal(pcrAudit.impact, "🚨 Penalty (-1 pt Reversal Risk)");
  assert.ok(result.pcrWarning.includes("HISTORICAL PEAK OVERBOUGHT"));
  assert.ok(pcrAudit.detail.includes("5-Year Historical Extreme"));
});

test("calculateEODDecision flags Tier 2 HISTORICAL_CAPITULATION_FLOOR and awards +1 pt contrarian bonus at PCR <= 0.52", () => {
  const result = calculateEODDecision({
    spot: 24000,
    floorStrike: 23900,
    roofStrike: 24100,
    totPutWriting: 50000,
    totCallWriting: 250000,
    pcr: 0.48, // 5-Year Deep Capitulation Floor (<= 0.52)
    deltaPcr: 0.35,
    timeline: [],
    dayOfWeek: 1,
    nowMins: 915,
  });

  const pcrAudit = result.audit.find(a => a.label.includes("PCR Structure"));
  assert.equal(pcrAudit.status, "HISTORICAL_CAPITULATION_FLOOR");
  assert.equal(pcrAudit.impact, "🚀 Bonus (+1 pt Squeeze Potential)");
  assert.ok(result.pcrWarning.includes("HISTORICAL CAPITULATION FLOOR"));
  assert.ok(pcrAudit.detail.includes("5-Year Historical Panic Floor"));
});
