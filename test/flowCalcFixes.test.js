// Flow calculation fixes (11-Nov-2026 review):
// 1. intraday futures quadrant, 2. closing-auction-aware windows,
// 3. two-leg writing-delta decomposition, 4. independent EOD evidence groups.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isSpotFrozenAt,
  spotWindowTouchesAuction,
  decomposeWritingDelta,
  classifyIntradayFuturesQuadrant,
  getFusionQuadrantMode,
  getIntradayQuadrantWindowMins,
} from "../src/flowCalc.js";
import { evaluateSmartMoneyFusion, selectFusionQuadrant } from "../src/smartMoneyFusion.js";
import { detectMacroTurn, calculateEODDecision, EOD_AGREEMENT_CAPS } from "../api/nifty-oi.js";
import { fuseChartWithOptionChain } from "../api/tv-webhook.js";

const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/nifty-oi-2026-11-11.json", import.meta.url), "utf8"));
const TL = FIXTURE.intradayTimeline;
const upTo = (hhmm) => TL.filter(p => p.time <= hhmm);
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ── helpers for synthetic timelines ──
function tick(minutes, { spot = 25000, fut = 25050, oi = 200000, put = 300000, call = 300000, live = true } = {}) {
  return { time: hm(minutes), minutes, spot, futPrice: fut, futCombinedOI: oi, putWriting: put, callWriting: call, netDiff: put - call, isLiveTick: live };
}
function series(fromMins, toMins, fn) {
  const out = [];
  for (let m = fromMins; m <= toMins; m++) out.push(tick(m, fn(m)));
  return out;
}

// ═════════════ 1. Intraday futures quadrant ═════════════

test("intraday quadrant: rolling 30m window classifies price/OI change with its own deadbands", () => {
  // Futures −60 pts on +0.5% OI over 30 minutes → SHORT_BUILDUP
  const ticks = series(840, 900, m => ({ fut: 25300 - (m - 840) * 2, oi: 200000 + (m - 840) * 30 }));
  const q = classifyIntradayFuturesQuadrant(ticks, { windowMins: 30 });
  assert.equal(q.available, true);
  assert.equal(q.quadrant, "SHORT_BUILDUP");
  assert.equal(q.window, "14:30→15:00");
  assert.equal(q.base.minutes, 870);
  assert.equal(q.priceChange, -60);
  // 15 pts move is inside the 0.08% (~20 pt) price deadband → chop
  const flat = series(840, 900, m => ({ fut: 25000 + (m - 840) * 0.25, oi: 200000 + (m - 840) * 30 }));
  assert.equal(classifyIntradayFuturesQuadrant(flat, { windowMins: 30 }).quadrant, "NEUTRAL_CHOP");
});

test("intraday quadrant: unavailable without enough ticks spanning the window", () => {
  assert.equal(classifyIntradayFuturesQuadrant([]).available, false);
  const short = series(880, 900, () => ({}));
  assert.match(classifyIntradayFuturesQuadrant(short, { windowMins: 30 }).reason, /does not yet span/);
  // base far before the window (feed gap) → unavailable
  const gappy = [tick(820), tick(898), tick(899), tick(900)];
  assert.match(classifyIntradayFuturesQuadrant(gappy, { windowMins: 30 }).reason, /no futures tick within/);
  // too few ticks inside the window
  const sparse = [tick(868), tick(900)];
  assert.match(classifyIntradayFuturesQuadrant(sparse, { windowMins: 30 }).reason, /futures tick\(s\) in the window/);
});

test("intraday quadrant: the current (not yet appended) reading replaces same-minute ticks", () => {
  const ticks = series(840, 900, () => ({ fut: 25000, oi: 200000 }));
  const q = classifyIntradayFuturesQuadrant(ticks, { windowMins: 30, current: { minutes: 900, futPrice: 25100, futCombinedOI: 201000 } });
  assert.equal(q.quadrant, "LONG_BUILDUP");
  assert.equal(q.end.futPrice, 25100);
});

test("fusion quadrant selection: day by default; FUSION_QUADRANT_MODE=intraday opts in, with day fallback", () => {
  const fut = { ...FIXTURE.futures, priceChangeBase: "PREV_CLOSE" };
  const iq = classifyIntradayFuturesQuadrant(upTo("15:13"));
  assert.equal(iq.quadrant, "SHORT_BUILDUP");

  const sel = selectFusionQuadrant(fut, iq, "intraday");
  assert.equal(sel.quadrantSource, "INTRADAY");
  assert.equal(sel.quadrantInfo.quadrant, "SHORT_BUILDUP");
  assert.equal(sel.quadrantDay.quadrant, "SHORT_COVERING");
  assert.equal(sel.quadrantDay.base, "previous close");

  const dayMode = selectFusionQuadrant(fut, iq, "day");
  assert.equal(dayMode.quadrantSource, "DAY");
  assert.equal(dayMode.quadrantInfo.quadrant, "SHORT_COVERING");
  assert.match(dayMode.quadrantSourceReason, /default whole-day quadrant/);
  // the rolling window is still exposed, as information only
  assert.equal(dayMode.quadrantIntraday.quadrant, "SHORT_BUILDUP");
  assert.equal(dayMode.quadrantIntradayInformational, true);
  assert.match(dayMode.quadrantIntradayInfoLabel, /last 30 min, informational: SHORT_BUILDUP/);
  // with no mode argument and no env, the default is day
  const prev = process.env.FUSION_QUADRANT_MODE;
  delete process.env.FUSION_QUADRANT_MODE;
  try {
    assert.equal(selectFusionQuadrant(fut, iq).quadrantSource, "DAY");
    assert.equal(evaluateSmartMoneyFusion(fut, { deltaPcr: 0.66, pcr: 0.77 }, { intradayQuadrant: iq }).quadrantSource, "DAY");
  } finally {
    if (prev !== undefined) process.env.FUSION_QUADRANT_MODE = prev;
  }

  const fallback = selectFusionQuadrant(fut, { available: false, reason: "only 1 futures tick(s) in the window (< 3)" }, "intraday");
  assert.equal(fallback.quadrantSource, "DAY");
  assert.match(fallback.quadrantSourceReason, /intraday window unavailable/);

  const stale = selectFusionQuadrant({ ...fut, isStale: true }, iq, "intraday");
  assert.equal(stale.quadrantSource, "DAY", "a stale futures snapshot never drives the intraday quadrant");

  const fusion = evaluateSmartMoneyFusion(fut, { deltaPcr: 0.66, pcr: 0.77 }, { intradayQuadrant: iq, mode: "intraday" });
  assert.equal(fusion.quadrantSource, "INTRADAY");
  assert.match(fusion.headline, /\[quadrant: 30m intraday 14:33→15:13\]/);
});

test("env: FUSION_QUADRANT_MODE and FUSION_INTRADAY_WINDOW_MINS", () => {
  const prevMode = process.env.FUSION_QUADRANT_MODE;
  const prevWin = process.env.FUSION_INTRADAY_WINDOW_MINS;
  try {
    delete process.env.FUSION_QUADRANT_MODE;
    assert.equal(getFusionQuadrantMode(), "day", "default is the whole-day quadrant");
    process.env.FUSION_QUADRANT_MODE = "intraday";
    assert.equal(getFusionQuadrantMode(), "intraday");
    process.env.FUSION_QUADRANT_MODE = "garbage";
    assert.equal(getFusionQuadrantMode(), "day");
    delete process.env.FUSION_INTRADAY_WINDOW_MINS;
    assert.equal(getIntradayQuadrantWindowMins(), 30);
    process.env.FUSION_INTRADAY_WINDOW_MINS = "45";
    assert.equal(getIntradayQuadrantWindowMins(), 45);
    process.env.FUSION_INTRADAY_WINDOW_MINS = "2";
    assert.equal(getIntradayQuadrantWindowMins(), 30);
  } finally {
    if (prevMode === undefined) delete process.env.FUSION_QUADRANT_MODE; else process.env.FUSION_QUADRANT_MODE = prevMode;
    if (prevWin === undefined) delete process.env.FUSION_INTRADAY_WINDOW_MINS; else process.env.FUSION_INTRADAY_WINDOW_MINS = prevWin;
  }
});

test("webhook: day-mode quadrant drives the veto; the 30m quadrant is informational only", () => {
  const base = { corridor: { deltaPCR: 0.5, floorStrike: 24990, roofStrike: 25300 } };
  const intra = { available: true, quadrant: "SHORT_BUILDUP", windowMins: 30, window: "14:33→15:13" };
  // Day quadrant LONG_BUILDUP, intraday SHORT_BUILDUP: the intraday one must not veto.
  const fused = fuseChartWithOptionChain({ grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25000 },
    { ...base, futures: { quadrant: "LONG_BUILDUP", quadrantSource: "DAY", quadrantSourceLabel: "day vs previous close", quadrantIntraday: intra } });
  assert.notEqual(fused.decision, "VETO_SIGNAL");
  assert.equal(fused.liveOptionChainMetrics.liveFutQuad, "LONG_BUILDUP");
  assert.equal(fused.liveOptionChainMetrics.intradayFutQuadInformational, "SHORT_BUILDUP");
  assert.match(fused.reasoning, /Last 30 min futures \(informational, not used for this decision\): SHORT_BUILDUP/);
  // Same signal and day quadrant without the intraday info: identical decision and sizing.
  const plain = fuseChartWithOptionChain({ grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25000 },
    { ...base, futures: { quadrant: "LONG_BUILDUP", quadrantSource: "DAY" } });
  assert.equal(plain.decision, fused.decision);
  assert.equal(plain.recommendedLots, fused.recommendedLots);
});

test("webhook (opt-in intraday mode): futures.quadrant drives the veto and its source is reported", () => {
  const scanner = {
    corridor: { deltaPCR: 0.5, floorStrike: 24990, roofStrike: 25300 },
    futures: { quadrant: "SHORT_BUILDUP", quadrantSource: "INTRADAY", quadrantSourceLabel: "30m intraday 14:33→15:13" },
  };
  const fused = fuseChartWithOptionChain({ grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25000 }, scanner);
  assert.equal(fused.decision, "VETO_SIGNAL");
  assert.equal(fused.liveOptionChainMetrics.serverFutQuadSource, "INTRADAY");
  assert.match(fused.reasoning, /\[quadrant: 30m intraday 14:33→15:13\]/);
});

// ═════════════ 2. Closing auction ═════════════

test("closing auction: spot frozen 15:15–15:30, windows touching it are flagged", () => {
  assert.equal(isSpotFrozenAt(914), false);
  assert.equal(isSpotFrozenAt(915), true);
  assert.equal(isSpotFrozenAt(929), true);
  assert.equal(isSpotFrozenAt(930), false);
  assert.equal(spotWindowTouchesAuction(885, 915), false, "a window ending at 15:15 is clean");
  assert.equal(spotWindowTouchesAuction(900, 920), true);
  assert.equal(spotWindowTouchesAuction(925, 936), true, "straddling the 15:30 print");
  assert.equal(spotWindowTouchesAuction(931, 940), false);
});

test("macro turn: the 15:30 auction jump in spot is not a price move (futures used instead)", () => {
  // Spot frozen at 25000 from 15:15, jumps +125 at 15:30. Futures drift flat. Call writing falls,
  // put writing falls harder → would have read as "spot +125, net −1L" under the old code.
  const ticks = series(880, 939, m => ({
    spot: m < 915 ? 25000 : m < 930 ? 25000 : 25125,
    fut: 25060,
    put: 400000 - (m - 880) * 2000,
    call: 400000 - (m - 880) * 300,
  }));
  const r = detectMacroTurn({ timeline: ticks, spot: 25125, floorStrike: 25000, roofStrike: 25300 });
  assert.equal(r.isTriggered, false);
  assert.equal(r.priceSource, "FUTURES");
  assert.doesNotMatch(r.message, /\+125/);
  assert.match(r.message, /closing auction/);
});

test("macro turn: candles never end after the current tick and need ≥3 live ticks each", () => {
  // Last tick 15:36: C2 = 15:30–15:36 with a single tick → no verdict
  const ticks = [...series(880, 925, () => ({})), tick(936, { spot: 25125 })];
  const r = detectMacroTurn({ timeline: ticks, spot: 25125, floorStrike: 25000, roofStrike: 25300 });
  assert.equal(r.isTriggered, false);
  assert.equal(r.status, "INSUFFICIENT_TICKS");
  assert.match(r.message, /C2 \(15:30-15:36\) has 1 live tick/);
  assert.doesNotMatch(r.message, /15:45/, "no candle may extend to 15:45");
});

test("macro turn: a WRITING-driven bull trap away from the auction still triggers, quoting both legs", () => {
  // 13:00–13:30: spot +40, call writing +60k, put writing flat
  const ticks = series(770, 812, m => ({
    spot: m < 780 ? 25000 : 25000 + (m - 780) * (40 / 30),
    fut: 25050,
    put: 300000,
    call: m < 780 ? 300000 : 300000 + (m - 780) * 2000,
  }));
  const r = detectMacroTurn({ timeline: ticks, spot: 25040, floorStrike: 24950, roofStrike: 25100 });
  assert.equal(r.isTriggered, true);
  assert.equal(r.type, "BULL_TRAP_REVERSAL");
  assert.equal(r.priceSource, "SPOT");
  assert.equal(r.flow.driver, "WRITING");
  assert.match(r.message, /put writing \+?0, call writing \+60\.0k/);
});

test("macro turn: UNWINDING-driven divergence is described honestly and does not trigger", () => {
  // Same spot rally but the bearish net comes from put writing being closed
  const ticks = series(770, 812, m => ({
    spot: m < 780 ? 25000 : 25000 + (m - 780) * (40 / 30),
    put: m < 780 ? 400000 : 400000 - (m - 780) * 2000,
    call: m < 780 ? 300000 : 300000 + (m - 780) * 200,
  }));
  const r = detectMacroTurn({ timeline: ticks, spot: 25040, floorStrike: 24950, roofStrike: 25100 });
  assert.equal(r.isTriggered, false);
  assert.equal(r.type, "UNWINDING_DIVERGENCE");
  assert.match(r.message, /put writers closing \/ support withdrawn/);
  assert.doesNotMatch(r.message, /TRAP \(/);
});

// ═════════════ 3. Writing-delta decomposition ═════════════

test("decomposeWritingDelta: writing, unwinding, mixed, unknown", () => {
  const p = (put, call) => ({ putWriting: put, callWriting: call, netDiff: put - call });
  const callWriting = decomposeWritingDelta(p(300000, 300000), p(305000, 360000));
  assert.equal(callWriting.direction, "BEARISH");
  assert.equal(callWriting.driver, "WRITING");
  assert.equal(callWriting.dominantLeg, "CALL");

  const putUnwind = decomposeWritingDelta(p(411701, 467320), p(322553, 491826)); // 11-Nov 15:25→15:36
  assert.equal(putUnwind.direction, "BEARISH");
  assert.equal(putUnwind.driver, "UNWINDING");
  assert.equal(putUnwind.dominantLeg, "PUT");
  assert.equal(putUnwind.putLegDelta, -89148);
  assert.equal(putUnwind.callLegDelta, 24506);
  assert.match(putUnwind.wording, /put writers closing \/ support withdrawn/);
  assert.match(putUnwind.wording, /call writing \+24\.5k/);

  // 55/45 split → mixed
  const mixed = decomposeWritingDelta(p(300000, 300000), p(255000, 336000));
  assert.equal(mixed.driver, "MIXED");

  const unknown = decomposeWritingDelta({ netDiff: 0 }, { netDiff: -50000 });
  assert.equal(unknown.driver, "UNKNOWN");
});

// ═════════════ 4. EOD evidence groups ═════════════

const eodBase = {
  spot: 24200, floorStrike: 24100, roofStrike: 24350,
  totPutWriting: 100000, totCallWriting: 100000, pcr: 1.05, deltaPcr: 1.10,
  dayOfWeek: 3, nowMins: 915,
};
const flowTicks = (put0, call0, put1, call1) => [
  { minutes: 855, time: "14:15", putWriting: put0, callWriting: call0, netDiff: put0 - call0 },
  { minutes: 885, time: "14:45", putWriting: (put0 + put1) / 2, callWriting: (call0 + call1) / 2, netDiff: (put0 + put1) / 2 - (call0 + call1) / 2 },
  { minutes: 915, time: "15:15", putWriting: put1, callWriting: call1, netDiff: put1 - call1 },
];

test("EOD group B: WRITING-driven blitz scores full tier; UNWINDING-driven is one tier lower and never a blitz", () => {
  const writing = calculateEODDecision({ ...eodBase, timeline: flowTicks(300000, 300000, 300000, 390000) });
  const wB = writing.audit.find(a => a.label === "Closing Hour Flow (14:15+)");
  assert.equal(wB.status, "INSTITUTIONAL_CALL_BLITZ");
  assert.equal(writing.groups.B.contribution, -3);

  const unwinding = calculateEODDecision({ ...eodBase, timeline: flowTicks(390000, 300000, 300000, 300000) });
  const uB = unwinding.audit.find(a => a.label === "Closing Hour Flow (14:15+)");
  assert.equal(uB.status, "BEARISH_PUT_UNWINDING");
  assert.equal(unwinding.groups.B.contribution, -2);
  assert.doesNotMatch(uB.detail, /Blitz|distribution/i);
  assert.match(uB.detail, /put writing -90\.0k/);
  assert.match(uB.detail, /call writing \+?0/);
  // no late-blitz veto on unwinding flow
  assert.equal(unwinding.audit.find(a => a.label.includes("Institutional Veto")), undefined);
});

test("EOD: each evidence group appears once; fusion and macro turn add no points", () => {
  const fusion = { scenarioId: "BEARISH_SYNERGY", badge: "x", headline: "h", rationale: "r", scoreBoost: -1, eodCarryVeto: null,
    quadrantInfo: { quadrant: "SHORT_BUILDUP", sourceLabel: "30m intraday 14:45→15:15" } };
  const macroTurn = { isTriggered: true, type: "BULL_TRAP_REVERSAL", message: "🚨 macro" };
  const r = calculateEODDecision({ ...eodBase, timeline: flowTicks(300000, 300000, 300000, 390000), fusion, macroTurn,
    futuresMetrics: { rawBasis: -5, adjustedBasisSpread: -40, intradayBasisDelta: -8 }, nowMins: 905 });
  const summaries = r.audit.filter(a => a.isGroupSummary).map(a => a.group);
  assert.deepEqual(summaries, ["A", "B", "C"]);
  assert.equal(r.score, r.groups.A.contribution + r.groups.B.contribution + r.groups.C.contribution,
    "score is exactly the three group contributions (no fusion boost, no macro add-on)");
  assert.equal(r.groups.C.contribution, -2, "short buildup + bearish basis");
  const macro = r.audit.find(a => a.label === "30-Min Macro Turn");
  assert.equal(macro.impact, "0 pts (counted in Group B)");
  const fus = r.audit.find(a => a.label === "Smart Money Futures Fusion");
  assert.match(fus.impact, /0 pts/);
});

test("EOD: basis is not scored while spot is frozen for the closing auction", () => {
  const r = calculateEODDecision({ ...eodBase, nowMins: 920, timeline: [],
    futuresQuadrant: { quadrant: "SHORT_BUILDUP" }, futuresMetrics: { rawBasis: -5, adjustedBasisSpread: -40, intradayBasisDelta: -8 } });
  assert.equal(r.groups.C.contribution, -1);
  assert.match(r.audit.find(a => a.label === "Futures Quadrant & Basis").detail, /basis not scored/);
});

test("EOD agreement score: capped by the number of agreeing groups and labelled as not a probability", () => {
  // Only group B agrees (blitz −3), A and C neutral
  const one = calculateEODDecision({ ...eodBase, spot: 24120, timeline: flowTicks(300000, 300000, 300000, 390000) });
  assert.equal(one.verdict, "CARRY NIFTY PE (STBT)");
  assert.deepEqual(one.agreement.groupsAgreeing, ["B"]);
  assert.ok(one.conviction <= EOD_AGREEMENT_CAPS[1]);
  assert.equal(one.agreement.isProbability, false);
  assert.match(one.convictionLabel, /not a probability/);

  // All three agree
  const three = calculateEODDecision({ ...eodBase, totPutWriting: 80000, totCallWriting: 220000, pcr: 0.82, deltaPcr: 0.55, spot: 24110,
    timeline: flowTicks(300000, 300000, 300000, 390000),
    futuresQuadrant: { quadrant: "SHORT_BUILDUP" }, futuresMetrics: { rawBasis: -5, adjustedBasisSpread: -40, intradayBasisDelta: -8 }, nowMins: 905 });
  assert.deepEqual(three.agreement.groupsAgreeing, ["A", "B", "C"]);
  assert.equal(three.conviction, EOD_AGREEMENT_CAPS[3]);
  assert.ok(three.conviction <= 90);
});

// ═════════════ 5. 11-Nov regression ═════════════

test("11-Nov fixture: captured 'before' readings are what the owner saw", () => {
  assert.equal(FIXTURE.fusion.scenarioId, "BULL_TRAP");
  assert.equal(FIXTURE.futures.quadrant, "SHORT_COVERING");
  assert.equal(FIXTURE.smartMoney.macroTurn.type, "BULL_TRAP_REVERSAL");
  assert.equal(FIXTURE.eodDecision.verdict, "CARRY NIFTY PE (STBT)");
  assert.equal(FIXTURE.eodDecision.conviction, 95);
  assert.equal(FIXTURE.eodDecision.lastHourNetDelta, -108743);
});

test("11-Nov regression: day vs intraday quadrant during the fall and at the close", () => {
  const expected = {
    "14:50": ["SHORT_COVERING", "LONG_UNWINDING"],
    "15:01": ["LONG_UNWINDING", "SHORT_BUILDUP"],
    "15:13": ["LONG_UNWINDING", "SHORT_BUILDUP"],
    "15:25": ["LONG_UNWINDING", "SHORT_BUILDUP"],
    "15:36": ["SHORT_COVERING", "LONG_BUILDUP"],
  };
  for (const [t, [day, intra]] of Object.entries(expected)) {
    const ticks = upTo(t);
    assert.equal(ticks.at(-1).futQuadrant, day, `${t} day-level quadrant as stored`);
    assert.equal(classifyIntradayFuturesQuadrant(ticks).quadrant, intra, `${t} intraday quadrant`);
  }
  // 12:40 sits after a 29-minute feed gap → intraday unavailable → day fallback
  assert.equal(classifyIntradayFuturesQuadrant(upTo("12:40")).available, false);
});

test("11-Nov regression: no '30-min macro bull trap' is manufactured from the frozen window", () => {
  for (const t of ["15:16", "15:18", "15:24", "15:25", "15:36"]) {
    const r = detectMacroTurn({ timeline: upTo(t), spot: upTo(t).at(-1).spot, floorStrike: FIXTURE.floor, roofStrike: FIXTURE.roof });
    assert.equal(r.isTriggered, false, `${t}: ${r.message}`);
    assert.doesNotMatch(r.message, /BULL TRAP/, t);
    assert.doesNotMatch(r.message, /15:45/, t);
  }
  const close = detectMacroTurn({ timeline: TL, spot: FIXTURE.spotPrice, floorStrike: FIXTURE.floor, roofStrike: FIXTURE.roof });
  assert.equal(close.status, "INSUFFICIENT_TICKS");
  assert.equal(close.priceSource, "FUTURES");
});

function closeReadings(mode) {
  const iq = classifyIntradayFuturesQuadrant(TL);
  const fusion = evaluateSmartMoneyFusion({ ...FIXTURE.futures, priceChangeBase: "PREV_CLOSE" },
    { deltaPcr: FIXTURE.deltaPcr, pcr: FIXTURE.pcr, totalPutWriting: FIXTURE.totalPutWriting, totalCallWriting: FIXTURE.totalCallWriting },
    { intradayQuadrant: iq, mode });
  const macroTurn = detectMacroTurn({ timeline: TL, spot: FIXTURE.spotPrice, floorStrike: FIXTURE.floor, roofStrike: FIXTURE.roof });
  const eod = calculateEODDecision({
    spot: FIXTURE.spotPrice, floorStrike: FIXTURE.floor, roofStrike: FIXTURE.roof,
    totPutWriting: FIXTURE.totalPutWriting, totCallWriting: FIXTURE.totalCallWriting,
    pcr: FIXTURE.pcr, deltaPcr: FIXTURE.deltaPcr, timeline: TL, dayOfWeek: 3, nowMins: 936,
    fusion, futuresQuadrant: fusion.quadrantInfo, futuresMetrics: FIXTURE.futures, macroTurn,
  });
  return { fusion, eod };
}

test("11-Nov regression (default day mode): fusion as before, closing flow UNWINDING-driven, each EOD group once", () => {
  const { fusion, eod } = closeReadings("day");
  assert.equal(fusion.scenarioId, "BULL_TRAP", "day quadrant SHORT_COVERING + ΔPCR 0.66 roof blitz, unchanged");
  assert.equal(fusion.quadrantSource, "DAY");
  assert.equal(fusion.quadrantInfo.quadrant, "SHORT_COVERING");
  assert.match(fusion.quadrantIntradayInfoLabel, /last 30 min, informational: LONG_BUILDUP \(15:06→15:36\)/);

  assert.equal(eod.closingFlow.driver, "UNWINDING");
  assert.equal(eod.audit.find(a => a.label === "Closing Hour Flow (14:15+)").status, "BEARISH_PUT_UNWINDING");
  assert.deepEqual(eod.audit.filter(a => a.isGroupSummary).map(a => a.group), ["A", "B", "C"]);
  assert.deepEqual([eod.groups.A.contribution, eod.groups.B.contribution, eod.groups.C.contribution], [-2, -2, 0]);
  assert.equal(eod.groups.C.quadrant, "SHORT_COVERING", "group C uses the mode-selected (day) quadrant");
  assert.equal(eod.score, -4);
  assert.equal(eod.verdict, "CARRY NIFTY PE (STBT)");
  assert.deepEqual(eod.agreement.groupsAgreeing, ["A", "B"]);
  assert.deepEqual(eod.agreement.groupsOpposing, []);
  assert.equal(eod.conviction, 69);
  assert.equal(eod.audit.find(a => a.label === "Smart Money Futures Fusion").status, "BEARISH_VETO",
    "bull-trap veto blocks BTST only; adds no points");
  assert.equal(eod.audit.find(a => a.label.includes("Institutional Veto")), undefined);
});

test("11-Nov regression (opt-in intraday mode): closing flow UNWINDING-driven with both legs quoted; each EOD group once", () => {
  const { fusion, eod } = closeReadings("intraday");
  assert.equal(fusion.scenarioId, "MIXED_FLOW", "no bull trap from a whole-day 'price up' label");
  assert.equal(fusion.quadrantSource, "INTRADAY");
  assert.equal(fusion.quadrantIntradayInformational, false);

  assert.equal(eod.lastHourNetDelta, -108743);
  assert.equal(eod.closingFlow.driver, "UNWINDING");
  assert.equal(eod.closingFlow.dominantLeg, "PUT");
  assert.equal(eod.closingFlow.putLegDelta, -177411);
  assert.equal(eod.closingFlow.callLegDelta, -68668);
  const closing = eod.audit.find(a => a.label === "Closing Hour Flow (14:15+)");
  assert.equal(closing.status, "BEARISH_PUT_UNWINDING");
  assert.match(closing.detail, /put writing -1\.8L/);
  assert.match(closing.detail, /call writing -68\.7k/);
  assert.doesNotMatch(closing.detail, /distribution|Blitz/i);

  const summaries = eod.audit.filter(a => a.isGroupSummary);
  assert.deepEqual(summaries.map(a => a.group), ["A", "B", "C"]);
  assert.deepEqual([eod.groups.A.contribution, eod.groups.B.contribution, eod.groups.C.contribution], [-2, -2, 1]);
  assert.equal(eod.score, -3);
  assert.equal(eod.verdict, "CARRY NIFTY PE (STBT)");
  assert.deepEqual(eod.agreement.groupsAgreeing, ["A", "B"]);
  assert.deepEqual(eod.agreement.groupsOpposing, ["C"]);
  assert.equal(eod.conviction, 59);
  assert.equal(eod.audit.find(a => a.label.includes("Institutional Veto")), undefined, "no late call blitz veto from put unwinding");
  assert.equal(eod.audit.find(a => a.label === "30-Min Macro Turn").impact, "0 pts (counted in Group B)");
});
