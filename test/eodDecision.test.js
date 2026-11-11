import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateEODDecision as calculateEODDecisionRaw,
  calculateDeltaPcr,
  isTodayExpiryDate,
  getActiveMonthlyExpiry,
  calculateDte,
  extractOptionChainMetrics,
  DEFAULT_EOD_SEED_HISTORY
} from "../api/nifty-oi.js";

// These scenarios were written when the closing flow was scored from netDiff alone. Real ticks
// always carry both corridor legs, and the scorer now requires them to tell fresh writing from
// unwinding. Fill missing legs so that every netDiff move is carried by WRITING on its own side
// (put writing up for +netDiff, call writing up for -netDiff) — i.e. the flow these scenarios
// describe. Ticks that already carry legs are left untouched.
const LEG_BASE = 300000;
const withLegs = (timeline) => (Array.isArray(timeline) ? timeline : []).map(pt =>
  pt && pt.putWriting === undefined && pt.callWriting === undefined && Number.isFinite(pt.netDiff)
    ? { ...pt, putWriting: LEG_BASE + Math.max(0, pt.netDiff), callWriting: LEG_BASE + Math.max(0, -pt.netDiff) }
    : pt
);
const calculateEODDecision = (args) => calculateEODDecisionRaw({ ...args, timeline: withLegs(args.timeline) });

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
  assert.ok(!result.action.includes("-+"), "Formatting must not contain double signs (-+)");
  assert.ok(!result.action.includes("++"), "Formatting must not contain double signs (++)");
  assert.ok(!result.action.includes(".."), "Formatting must not contain double periods");
  assert.equal(result.stopLoss, 24650, "Stop loss must point to roofStrike 24650");
  assert.equal(result.target, 24400, "Target must point to floorStrike 24400");
  assert.ok(result.action.includes("Strict SL at 24650"), "Action must include explicit SL level");
  assert.ok(result.action.includes("Target: Morning gap-down toward Floor (24400)"), "Action must include explicit Target");
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

test("calculateEODDecision enforces data integrity validation: requires >= 15m closing span and holds scoring neutral when ticks missing", () => {
  // Scenario: Timeline only has 1 tick at 14:15 and 1 tick at 14:20 (< 15 min span)
  const result = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 200000,
    totCallWriting: 100000,
    pcr: 1.15,
    deltaPcr: 1.25,
    timeline: [
      { minutes: 855, netDiff: 10000, time: "14:15" },
      { minutes: 860, netDiff: 90000, time: "14:20" }, // +80k jump in 5 mins but span is only 5 mins!
      { minutes: 862, netDiff: 90000, time: "14:22" }
    ],
    dayOfWeek: 3,
    nowMins: 915, // 15:15 IST
  });

  assert.equal(result.isClosingDataValid, false, "isClosingDataValid must be false when span < 15m");
  const closingAudit = result.audit.find(a => a.label.includes("Closing Hour Flow"));
  assert.equal(closingAudit.status, "AWAITING_DATA");
  assert.ok(closingAudit.detail.includes("Data Integrity Notice"));
  assert.equal(closingAudit.impact, "0 pts (Data Pending)");

  // Crucially: late blitz veto must NOT trigger on unvalidated short span
  const vetoAudit = result.audit.find(a => a.label.includes("14:15+ Institutional Veto"));
  assert.equal(vetoAudit, undefined, "Veto must never fire when closing data integrity validation fails");
});

test("calculateEODDecision enforces data integrity validation: holds neutral when 14:15 anchor is missing", () => {
  // Scenario: Morning ticks only (555, 600, 660) and then a single post-market tick at 15:40 (no 14:15 baseline)
  const result = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 200000,
    totCallWriting: 100000,
    pcr: 1.15,
    deltaPcr: 1.25,
    timeline: [
      { minutes: 555, netDiff: 5000, time: "09:15" },
      { minutes: 600, netDiff: 15000, time: "10:00" },
      { minutes: 660, netDiff: 20000, time: "11:00" },
      { minutes: 940, netDiff: -100000, time: "15:40" } // Huge negative jump at 15:40, but no 14:15 tick
    ],
    dayOfWeek: 3,
    nowMins: 998, // 16:38 IST (user refresh after hours)
  });

  assert.equal(result.isClosingDataValid, false);
  const closingAudit = result.audit.find(a => a.label.includes("Closing Hour Flow"));
  assert.equal(closingAudit.status, "AWAITING_DATA");
  assert.ok(closingAudit.detail.includes("Missing 14:15 IST baseline tick"));
  assert.equal(closingAudit.impact, "0 pts (Data Pending)");

  // Late call blitz veto must NOT trigger from disconnected morning to 15:40 gap
  const vetoAudit = result.audit.find(a => a.label.includes("14:15+ Institutional Veto"));
  assert.equal(vetoAudit, undefined, "Veto must not fire from disconnected timeline missing 14:15 anchor");
});

test("calculateEODDecision displays exact verified window (14:15 to 15:30) when data integrity validation succeeds", () => {
  const result = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 200000,
    totCallWriting: 100000,
    pcr: 1.15,
    deltaPcr: 1.25,
    timeline: [
      { minutes: 855, netDiff: 10000, time: "14:15" },
      { minutes: 885, netDiff: 30000, time: "14:45" },
      { minutes: 930, netDiff: 55000, time: "15:30" } // Span is 75 mins, delta is +45,000
    ],
    dayOfWeek: 3,
    nowMins: 930,
  });

  assert.equal(result.isClosingDataValid, true);
  const closingAudit = result.audit.find(a => a.label.includes("Closing Hour Flow"));
  assert.equal(closingAudit.status, "BULLISH");
  assert.equal(closingAudit.impact, "+2 pts");
  assert.ok(closingAudit.detail.includes("(14:15 to 15:30)"), "Must display verified window timestamps");
});

test("calculateEODDecision sets evening review status active until 23:00 IST and resets to pre-market at 23:00+", () => {
  const baseTimeline = [
    { minutes: 855, netDiff: 10000, time: "14:15" },
    { minutes: 900, netDiff: 30000, time: "15:00" },
    { minutes: 940, netDiff: 50000, time: "15:40" }
  ];

  // 1. Post-market evening review (e.g. 19:30 IST / 1170 mins): Active until 23:00 IST
  const eveningResult = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 200000,
    totCallWriting: 100000,
    pcr: 1.15,
    deltaPcr: 1.25,
    timeline: baseTimeline,
    dayOfWeek: 3,
    nowMins: 1170, // 19:30 IST
  });

  assert.ok(eveningResult.statusLabel.includes("MARKET CLOSED · EOD DECISION SETTLED AT 15:40 IST"));
  assert.ok(eveningResult.statusLabel.includes("Active until 23:00 IST"));
  assert.equal(eveningResult.isClosingDataValid, true);

  // 2. Overnight reset (e.g. 23:15 IST / 1395 mins): Resets to pre-market
  const overnightResult = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 200000,
    totCallWriting: 100000,
    pcr: 1.15,
    deltaPcr: 1.25,
    timeline: baseTimeline,
    dayOfWeek: 3,
    nowMins: 1395, // 23:15 IST
  });

  assert.equal(overnightResult.statusLabel, "PRE-MARKET · AWAITING 09:15 IST OPEN");
});

test("calculateEODDecision handles Sunday Diwali Muhurat session lifecycles (pre-market, monitoring, execution window, settled evening review)", () => {
  const diwaliTimeline = [
    { minutes: 840, netDiff: 5000, time: "14:00" },
    { minutes: 860, netDiff: 15000, time: "14:20" },
    { minutes: 900, netDiff: 45000, time: "15:00" },
    { minutes: 920, netDiff: 65000, time: "15:20" },
    { minutes: 960, netDiff: 75000, time: "16:00" }
  ];

  // 1. Sunday Pre-market (e.g. 11:30 IST / 690 mins)
  const preRes = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    timeline: diwaliTimeline,
    dayOfWeek: 0, // Sunday
    nowMins: 690,
  });
  assert.equal(preRes.isSunday, true);
  assert.equal(preRes.isFriday, false);
  assert.ok(preRes.statusLabel.includes("DIWALI MUHURAT PRE-MARKET"));
  assert.ok(preRes.statusLabel.includes("WINDOW OPENS AT 14:00 IST"));

  // 2. Sunday Monitoring & Trading Active (e.g. 14:35 IST / 875 mins)
  const monitorRes = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    timeline: diwaliTimeline,
    dayOfWeek: 0,
    nowMins: 875,
  });
  assert.ok(monitorRes.statusLabel.includes("DIWALI MUHURAT MONITORING"));
  assert.ok(monitorRes.statusLabel.includes("TRADING ACTIVE (14:20 - 15:20 IST)"));

  // 3. Sunday Execution Window (e.g. 15:10 IST / 910 mins)
  const execRes = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 250000,
    totCallWriting: 100000,
    pcr: 1.25,
    deltaPcr: 1.6,
    timeline: diwaliTimeline,
    dayOfWeek: 0,
    nowMins: 910,
  });
  assert.equal(execRes.isDecisionWindow, true);
  assert.ok(execRes.statusLabel.includes("DIWALI MUHURAT EXECUTION WINDOW"));
  assert.equal(execRes.verdict, "CARRY NIFTY CE (BTST)");
  assert.equal(execRes.sizing, "75% Normal Size"); // Normal sizing, Monday opens in <18 hours

  // 4. Sunday Evening Review Window (e.g. 17:30 IST / 1050 mins)
  const eveRes = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 250000,
    totCallWriting: 100000,
    pcr: 1.25,
    deltaPcr: 1.6,
    timeline: diwaliTimeline,
    dayOfWeek: 0,
    nowMins: 1050,
  });
  assert.ok(eveRes.statusLabel.includes("DIWALI MUHURAT CLOSED · EOD DECISION SETTLED AT 16:00 IST"));
  assert.ok(eveRes.statusLabel.includes("Active until 23:00 IST"));
  assert.equal(eveRes.isClosingDataValid, true);

  // 5. Sunday 23:00+ Reset
  const resetRes = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    timeline: diwaliTimeline,
    dayOfWeek: 0,
    nowMins: 1390,
  });
  assert.ok(resetRes.statusLabel.includes("DIWALI MUHURAT PRE-MARKET"));
});

test("calculateEODDecision anchors closing flow at 14:20 and handles late blitz in Sunday Diwali Muhurat session", () => {
  const diwaliLateCallTimeline = [
    { minutes: 840, netDiff: 10000, time: "14:00" },
    { minutes: 860, netDiff: 20000, time: "14:20" },
    { minutes: 900, netDiff: -20000, time: "15:00" },
    { minutes: 920, netDiff: -65000, time: "15:20" } // Drop of 85k lots from 14:20
  ];

  const result = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24600,
    totPutWriting: 150000,
    totCallWriting: 140000,
    pcr: 1.05,
    deltaPcr: 0.95,
    timeline: diwaliLateCallTimeline,
    dayOfWeek: 0, // Sunday
    nowMins: 920,
  });

  assert.equal(result.isClosingDataValid, true);
  const closingAudit = result.audit.find(a => a.label.includes("Diwali Muhurat Closing Flow"));
  assert.ok(closingAudit, "Must have Diwali Muhurat Closing Flow audit");
  assert.equal(closingAudit.status, "INSTITUTIONAL_CALL_BLITZ");
  assert.equal(closingAudit.impact, "-3 pts (Institutional Blitz)");

  // Late Veto should trigger
  const vetoAudit = result.audit.find(a => a.label.includes("Muhurat Institutional Veto Guardrail"));
  assert.ok(vetoAudit, "Must have Muhurat Institutional Veto Guardrail");
  assert.ok(result.action.includes("LATE CALL BLITZ VETO"));
  assert.ok(result.action.includes("BTST strictly forbidden"));
  assert.equal(result.stopLoss, 24600);
});

test("calculateEODDecision integrates Smart Money Futures Fusion and enforces Bull Trap VETO_BTST", () => {
  // Scenario: Options show bullish put writing (score would normally be +3 BTST)
  // But Futures show Short-Covering rally into a massive Call wall at Roof -> BULL_TRAP
  const fusionBullTrap = {
    scenarioId: "BULL_TRAP",
    badge: "🚨 BULL TRAP DETECTED",
    headline: "Price Up on Short-Covering + Call Blitz at Roof",
    actionableVerdict: "Veto Longs / Short with Strict SL",
    eodCarryVeto: "VETO_BTST",
    scoreBoost: -1,
    color: "#f59e0b",
    rationale: "Rally is driven only by short-covering while institutions write massive Calls at Roof.",
  };

  const result = calculateEODDecision({
    spot: 24500,
    floorStrike: 24400,
    roofStrike: 24650,
    totPutWriting: 250000,
    totCallWriting: 140000,
    pcr: 1.25,
    deltaPcr: 1.55,
    timeline: [
      { minutes: 855, netDiff: 10000, time: "14:15" },
      { minutes: 900, netDiff: 35000, time: "15:00" },
      { minutes: 930, netDiff: 45000, time: "15:30" }
    ],
    dayOfWeek: 3, // Wednesday
    nowMins: 930,
    fusion: fusionBullTrap,
  });

  // Verdict MUST be downgraded from BTST to CASH
  assert.equal(result.verdict, "EXIT TO CASH / DO NOT CARRY");
  assert.equal(result.bias, "NEUTRAL");
  assert.ok(result.action.includes("FUSION BULL TRAP VETO"));
  assert.ok(result.action.includes("BTST strictly forbidden"));

  // Check 5th Confluence Pillar in Audit
  const fusionAudit = result.audit.find(a => a.label === "Smart Money Futures Fusion");
  assert.ok(fusionAudit, "Must have 5th pillar 'Smart Money Futures Fusion' in audit");
  assert.equal(fusionAudit.status, "BEARISH_VETO");
  assert.equal(fusionAudit.impact, "VETO BTST (Bull Trap)");
});

test("calculateEODDecision integrates Smart Money Futures Fusion and enforces Bear Trap VETO_STBT", () => {
  // Scenario: Options show bearish call writing (score would normally be -3 STBT)
  // But Futures show Long-Unwinding dip absorbed by massive Floor Put writing -> BEAR_TRAP
  const fusionBearTrap = {
    scenarioId: "BEAR_TRAP",
    badge: "🟢 BEAR TRAP (DIP ABSORPTION)",
    headline: "Price Down on Long Unwinding + Put Blitz at Floor",
    actionableVerdict: "Veto Shorts / Buy Dips at Support",
    eodCarryVeto: "VETO_STBT",
    scoreBoost: +1,
    color: "#10b981",
    rationale: "Drop is driven by long unwinding while institutions absorb the dip with heavy Put writing.",
  };

  const result = calculateEODDecision({
    spot: 24180,
    floorStrike: 24100,
    roofStrike: 24300,
    totPutWriting: 80000,
    totCallWriting: 220000,
    pcr: 0.82,
    deltaPcr: 0.55,
    timeline: [
      { minutes: 855, netDiff: -10000, time: "14:15" },
      { minutes: 900, netDiff: -35000, time: "15:00" },
      { minutes: 930, netDiff: -45000, time: "15:30" }
    ],
    dayOfWeek: 4, // Thursday
    nowMins: 930,
    fusion: fusionBearTrap,
  });

  // Verdict MUST be downgraded from STBT to CASH
  assert.equal(result.verdict, "EXIT TO CASH / DO NOT CARRY");
  assert.equal(result.bias, "NEUTRAL");
  assert.ok(result.action.includes("FUSION BEAR TRAP VETO"));
  assert.ok(result.action.includes("STBT strictly forbidden"));

  // Check 5th Confluence Pillar in Audit
  const fusionAudit = result.audit.find(a => a.label === "Smart Money Futures Fusion");
  assert.ok(fusionAudit, "Must have 5th pillar 'Smart Money Futures Fusion' in audit");
  assert.equal(fusionAudit.status, "BULLISH_VETO");
  assert.equal(fusionAudit.impact, "VETO STBT (Bear Trap)");
});

test("isTodayExpiryDate correctly identifies today's expiry in IST", () => {
  const fakeNov9 = new Date("2026-11-09T14:15:00+05:30");
  assert.equal(isTodayExpiryDate("09-Nov-2026", fakeNov9), true);
  assert.equal(isTodayExpiryDate("17-Nov-2026", fakeNov9), false);
  assert.equal(isTodayExpiryDate("", fakeNov9), false);
  assert.equal(isTodayExpiryDate(null, fakeNov9), false);
});

test("getActiveMonthlyExpiry selects current month <=15th and rolls to next month >15th", () => {
  const expiries = [
    "09-Nov-2026", "17-Nov-2026", "23-Nov-2026",
    "01-Dec-2026", "08-Dec-2026", "29-Dec-2026",
    "25-Jan-2027"
  ];

  // Nov 9 <= 15: Selects 23-Nov-2026 (current month end)
  const dateBefore15 = new Date("2026-11-09T10:00:00+05:30");
  assert.equal(getActiveMonthlyExpiry(expiries, dateBefore15), "23-Nov-2026");

  // Nov 16 > 15: Rolls to 29-Dec-2026 (next month end)
  const dateAfter15 = new Date("2026-11-16T10:00:00+05:30");
  assert.equal(getActiveMonthlyExpiry(expiries, dateAfter15), "29-Dec-2026");
});

test("calculateDte calculates days to expiry correctly", () => {
  const fakeNov9 = new Date("2026-11-09T10:00:00+05:30");
  assert.equal(calculateDte("09-Nov-2026", fakeNov9), 1);
  assert.equal(calculateDte("17-Nov-2026", fakeNov9), 9);
  assert.equal(calculateDte("23-Nov-2026", fakeNov9), 15);
  assert.equal(calculateDte("", fakeNov9), 0);
});

test("extractOptionChainMetrics extracts writing, OI, floor, roof, deltaPCR, and PCR", () => {
  const sampleRecords = [
    { strikePrice: 24900, PE: { changeinOpenInterest: 20000, openInterest: 80000 }, CE: { changeinOpenInterest: 5000, openInterest: 30000 } },
    { strikePrice: 25000, PE: { changeinOpenInterest: 15000, openInterest: 50000 }, CE: { changeinOpenInterest: 25000, openInterest: 90000 } },
    { strikePrice: 25100, PE: { changeinOpenInterest: 2000, openInterest: 10000 }, CE: { changeinOpenInterest: 35000, openInterest: 110000 } }
  ];

  const metrics = extractOptionChainMetrics(sampleRecords, 25000);
  assert.equal(metrics.floorStrike, 24900);
  assert.equal(metrics.roofStrike, 25100);
  assert.equal(metrics.totPutWriting, 37000);
  assert.equal(metrics.totCallWriting, 65000);
  assert.ok(metrics.deltaPcr < 1.0);
  assert.ok(metrics.pcr < 1.0);
});

test("calculateEODDecision records Expiry Day Rollover Protocol in audit when isRollover is true", () => {
  const result = calculateEODDecision({
    spot: 25000,
    floorStrike: 24900,
    roofStrike: 25100,
    totPutWriting: 40000,
    totCallWriting: 120000,
    pcr: 0.75,
    deltaPcr: 0.40,
    dayOfWeek: 1, // Monday
    nowMins: 915,
    targetContract: "17-Nov-2026",
    isRollover: true,
  });

  assert.equal(result.targetContract, "17-Nov-2026");
  assert.equal(result.isRollover, true);
  const rolloverAudit = result.audit.find(a => a.label === "Expiry Day Rollover Protocol");
  assert.ok(rolloverAudit, "Must include Expiry Day Rollover Protocol in audit");
  assert.equal(rolloverAudit.status, "NEXT_WEEK_EVALUATED");
  assert.ok(rolloverAudit.detail.includes("17-Nov-2026"));
});

