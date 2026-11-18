import test from "node:test";
import assert from "node:assert/strict";
import { simulateExitRules, evaluateDayExitRules, aggregateExitRules, formatExitRuleLines, EXIT_RULES } from "../src/exitRuleShadow.js";
import { formatDailyTelegram } from "../src/scorecard.js";

// Synthetic futures series: one tick a minute 09:15–15:40, spot = futures − 30 (basis 30).
const BASIS = 30;
function series(priceAt) {
  const m = [], f = [], s = [];
  for (let x = 555; x <= 940; x++) {
    const p = priceAt(x);
    if (p == null) continue;
    m.push(x); f.push(p); s.push(p - BASIS);
  }
  return { m, f, s };
}
const hh = (x) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
// A long signal at 10:00 (600) on spot 25000 = futures 25030: stop 24940 / T1 25120 / T2 25200 (spot).
const LONG = { id: "SIGNAL:X:600", section: "SIGNAL", time: "10:00", minutes: 600, direction: "BULLISH", data: { grade: "SYNERGY_BULL", entry: 25000, sl: 24940, t1: 25120, t2: 25200, tradeId: "ft-1" } };
const turn = (minutes, type, direction) => ({ id: `TURN:${type}:${minutes}:${direction}`, section: "TURN", type, direction, minutes, time: hh(minutes) });
const pts = (r, k) => r.rules[k].pts;

test("no tracker readings: every rule equals the baseline (T2 reached)", () => {
  const sr = series((x) => 25030 + Math.max(0, x - 600) * 2); // +2 pts a minute
  const r = simulateExitRules(LONG, sr, []);
  assert.equal(r.status, "MEASURED");
  assert.equal(r.entry.fut, 25030);
  assert.equal(r.rules.BASELINE.reason, "T2");
  for (const rule of EXIT_RULES) assert.equal(pts(r, rule.key), pts(r, "BASELINE"));
});

test("price falls to the stop after a LIKELY bearish reading: C exits early and dodges the stop; B waits for CONFIRMED", () => {
  const sr = series((x) => (x <= 600 ? 25030 : 25030 - (x - 600) * 2)); // −2 a minute
  const turns = [turn(610, "EARLY", "BEARISH"), turn(620, "LIKELY_TURN", "BEARISH")];
  const r = simulateExitRules(LONG, sr, turns);
  assert.equal(r.rules.BASELINE.reason, "STOP");
  assert.equal(pts(r, "BASELINE"), -60); // stop 24940 spot + 30 basis = 24970 fut, reached at 10:30
  assert.equal(r.rules.EXIT_LIKELY.reason, "TRACKER_LIKELY_TURN");
  assert.equal(pts(r, "EXIT_LIKELY"), -40); // exit at 10:20's price 24990
  assert.equal(r.rules.EXIT_EARLY.exit, "10:10");
  assert.equal(pts(r, "EXIT_EARLY"), -20);
  assert.equal(pts(r, "EXIT_CONFIRMED"), pts(r, "BASELINE"), "no CONFIRMED reading → same as baseline");
  assert.equal(r.rules.EXIT_LIKELY.vsBaseline, 20);
});

test("a winner with a brief EARLY bearish reading: E cuts it, A/B/C/D keep it", () => {
  const sr = series((x) => 25030 + Math.max(0, x - 600) * 2);
  const r = simulateExitRules(LONG, sr, [turn(615, "EARLY", "BEARISH")]);
  assert.equal(r.rules.BASELINE.reason, "T2");
  assert.equal(pts(r, "EXIT_EARLY"), 30);
  assert.ok(pts(r, "EXIT_EARLY") < pts(r, "BASELINE"));
  for (const k of ["EXIT_CONFIRMED", "EXIT_LIKELY", "PROTECT_LIKELY"]) assert.equal(pts(r, k), pts(r, "BASELINE"));
});

test("D moves the stop to entry on LIKELY against, then exits near entry instead of at the stop", () => {
  // up 40 pts, LIKELY bearish at 10:20, then down through entry to the original stop
  const sr = series((x) => (x <= 600 ? 25030 : x <= 620 ? 25030 + (x - 600) * 2 : 25070 - (x - 620) * 3));
  const r = simulateExitRules(LONG, sr, [turn(620, "LIKELY_TURN", "BEARISH")]);
  assert.equal(r.rules.BASELINE.reason, "STOP");
  assert.equal(r.rules.PROTECT_LIKELY.reason, "PROTECTED_STOP");
  assert.ok(pts(r, "PROTECT_LIKELY") > pts(r, "BASELINE"));
  assert.ok(pts(r, "PROTECT_LIKELY") <= 0 && pts(r, "PROTECT_LIKELY") > -5, "fills at the first minute at/under entry");
});

test("readings before entry, or in the position's own direction, are ignored", () => {
  const sr = series((x) => (x <= 600 ? 25030 : 25030 - (x - 600) * 2));
  const r = simulateExitRules(LONG, sr, [turn(590, "CONFIRMED", "BEARISH"), turn(610, "CONFIRMED", "BULLISH")]);
  for (const rule of EXIT_RULES) assert.equal(pts(r, rule.key), pts(r, "BASELINE"));
});

test("a gap through the stop fills at that minute's price, not the stop level", () => {
  const sr = series((x) => (x <= 605 ? 25030 : 24900));
  const r = simulateExitRules(LONG, sr, []);
  assert.equal(r.rules.BASELINE.exitPrice, 24900);
  assert.equal(pts(r, "BASELINE"), -130);
});

test("square-off at 15:36 when nothing else exits", () => {
  const r = simulateExitRules(LONG, series((x) => (x <= 600 ? 25030 : 25040)), []);
  assert.equal(r.rules.BASELINE.reason, "SQUARE_OFF");
  assert.equal(r.rules.BASELINE.exit, "15:36");
  assert.equal(pts(r, "BASELINE"), 10);
});

test("a short mirrors a long", () => {
  const SHORT = { ...LONG, id: "SIGNAL:Y:600", direction: "BEARISH", data: { ...LONG.data, sl: 25060, t1: 24880, t2: 24800 } };
  const sr = series((x) => (x <= 600 ? 25030 : 25030 + (x - 600) * 2));
  const r = simulateExitRules(SHORT, sr, [turn(620, "LIKELY_TURN", "BULLISH")]);
  assert.equal(r.rules.BASELINE.reason, "STOP");
  assert.equal(pts(r, "EXIT_LIKELY"), -40);
});

test("data gap in the position window → UNMEASURABLE; missing levels → UNMEASURABLE", () => {
  const gappy = series((x) => (x > 630 && x < 660 ? null : 25030));
  assert.equal(simulateExitRules(LONG, gappy, []).status, "UNMEASURABLE");
  assert.equal(simulateExitRules({ ...LONG, data: { entry: 25000 } }, series(() => 25030), []).status, "UNMEASURABLE");
});

test("day evaluation marks traded positions; the aggregate counts a candidate + signal on the same bar once", () => {
  const sr = series((x) => (x <= 600 ? 25030 : 25030 - (x - 600) * 2));
  const cand = { ...LONG, id: "CANDIDATE:X:600", section: "CANDIDATE", data: { ...LONG.data, tradeId: undefined } };
  const doc = { date: "2026-11-19", series: sr, events: [LONG, cand, turn(620, "LIKELY_TURN", "BEARISH"), { id: "TRADE:1", section: "TRADE", data: { tradeId: "ft-1" } }] };
  const rows = evaluateDayExitRules(doc);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.source === "SIGNAL").executed, true);
  const a = aggregateExitRules([doc], { minSample: 30 });
  assert.equal(a.all.measurable, 1, "one position, not two");
  assert.equal(a.signals.measurable, 1);
  assert.equal(a.candidates.measurable, 1);
  assert.equal(a.executed.measurable, 1);
  assert.equal(a.sessions, 1);
  assert.equal(a.all.tooFewToJudge, true);
  const c = a.all.rules.EXIT_LIKELY;
  assert.equal(c.betterThanBaseline, 1);
  assert.equal(c.dodgedStops, 1);
  assert.equal(c.cutWinners, 0);
});

test("daily Telegram gets the exit-rule block only when the day has a measurable position", () => {
  const sr = series((x) => 25030 + Math.max(0, x - 600) * 2);
  const doc = { date: "2026-11-19", series: sr, events: [LONG], outcomes: {}, dataQuality: { state: "OK", coveragePct: 100 } };
  const text = formatDailyTelegram(doc, { candidates: false });
  assert.match(text, /Exit rules\* \(shadow, futures pts, 1 position\(s\)\)/);
  assert.match(text, /A Hold to stop \/ target \/ square-off \(baseline\): \+200/);
  assert.equal(formatExitRuleLines([]).length, 0);
  assert.doesNotMatch(formatDailyTelegram({ ...doc, events: [] }, { candidates: false }), /Exit rules/);
  assert.doesNotThrow(() => formatDailyTelegram({ ...doc, series: undefined }, { candidates: false }));
});
