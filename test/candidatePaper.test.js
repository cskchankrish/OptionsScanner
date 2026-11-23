import test from "node:test";
import assert from "node:assert/strict";
import { paperTradesForDay, buildCandidateLedger, buildCandidatePaper, getCandidatePaperConfig, formatCandidatePaperLines } from "../src/candidatePaper.js";
import { formatDailyTelegram } from "../src/scorecard.js";

const CFG = getCandidatePaperConfig({});

/** A day whose futures (spot + 10) follow `path(minute)` from 09:15 to 15:38. */
function day(date, path, events) {
  const m = [], s = [], f = [];
  for (let x = 555; x <= 938; x++) { const p = path(x); m.push(x); s.push(p); f.push(p + 10); }
  return { date, series: { m, s, f }, events };
}
const cand = ({ minutes, dir = "SHORT", entry, sl, t1, t2, category = "CONFIRMED", grade = dir === "SHORT" ? "SYNERGY_BEAR_CAND" : "SYNERGY_BULL_CAND" }) => ({
  id: `CANDIDATE:${grade}:${minutes}`, t: minutes * 60000, minutes, time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
  section: "CANDIDATE", type: grade, direction: dir === "SHORT" ? "BEARISH" : "BULLISH", spot: entry,
  data: { realGrade: grade.replace("_CAND", ""), category, entry, sl, t1, t2, deltaPcr: 0.35 },
});

// A steady fall: 25600 at 11:20 (680), −1 pt a minute
const fall = (x) => 25600 - (x - 680);

test("a confirmed synergy candidate inside the stop limit is taken and managed like the Algo (T1 → stop to entry, T2)", () => {
  const d = day("2026-11-23", fall, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]);
  const [x] = paperTradesForDay(d, CFG);
  assert.equal(x.status, "TAKEN");
  assert.equal(x.entryFut, 25610, "futures at the entry minute");
  assert.equal(x.slFut, 25710, "spot stop shifted by the basis");
  assert.equal(x.reason, "T2");
  assert.equal(x.exit, "14:40", "T2 25410 (fut) reached 200 minutes later");
  assert.equal(x.pts, 200);
  assert.equal(x.r, 2);
});

test("a stop wider than the Algo's 120 pts: strict skips it (hypothetical shown), capped takes it with the stop pulled in", () => {
  const d = day("2026-11-23", fall, [cand({ minutes: 680, entry: 25593.9, sl: 25820.16, t1: 25367.64, t2: 25141.38 })]);
  const [s] = paperTradesForDay(d, { ...CFG, stopPolicy: "REJECT" });
  assert.equal(s.status, "SKIPPED_STOP_TOO_WIDE");
  assert.equal(s.riskSpotPts, 226.26);
  assert.ok(s.hypothetical && s.hypothetical.pts > 0);
  const [c] = paperTradesForDay(d, { ...CFG, stopPolicy: "CAP" });
  assert.equal(c.status, "TAKEN");
  assert.equal(c.stopCapped, true);
  assert.equal(c.sl, 25713.9, "entry + 120");
  assert.equal(c.originalSl, 25820.16);
  assert.ok(c.originalStopResult, "the own-stop result is kept for comparison");
});

test("only confirmed synergy candidates by default; other verdicts and trap candidates are not paper-traded", () => {
  const evs = [
    cand({ minutes: 600, entry: 25680, sl: 25760, t1: 25600, t2: 25500, category: "UNCONFIRMED" }),
    cand({ minutes: 610, entry: 25670, sl: 25750, t1: 25590, t2: 25490, category: "REJECTED" }),
    { ...cand({ minutes: 620, dir: "LONG", entry: 25660, sl: 25600, t1: 25720, t2: 25800 }), type: "BEAR_TRAP_BUY_CAND" },
  ];
  assert.equal(paperTradesForDay(day("2026-11-23", fall, evs), CFG).length, 0);
  // configurable: include UNCONFIRMED
  const more = paperTradesForDay(day("2026-11-23", fall, evs), getCandidatePaperConfig({ CAND_PAPER_CATEGORIES: "CONFIRMED,UNCONFIRMED" }));
  assert.equal(more.length, 1);
});

test("one position at a time: a candidate while the previous paper position is open is skipped", () => {
  const evs = [
    cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 }),
    cand({ minutes: 700, entry: 25580, sl: 25680, t1: 25480, t2: 25380 }),
  ];
  const rows = paperTradesForDay(day("2026-11-23", fall, evs), CFG);
  assert.deepEqual(rows.map((r) => r.status), ["TAKEN", "SKIPPED_POSITION_OPEN"]);
  assert.match(rows[1].reason, /open until 14:40/);
});

test("ledger statistics, halves and the go-live check", () => {
  const up = (x) => 25600 + (x - 680); // against a short: stopped
  const days = [
    day("2026-11-17", fall, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), // +200
    day("2026-11-18", up, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), // −100 (stop)
    day("2026-11-19", fall, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), // +200
    day("2026-11-20", fall, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), // +200
  ];
  const L = buildCandidateLedger(days, CFG);
  assert.equal(L.taken.n, 4);
  assert.equal(L.taken.winners, 3);
  assert.equal(L.taken.losers, 1);
  assert.equal(L.taken.totalPts, 500);
  assert.equal(L.taken.profitFactor, 6);
  assert.equal(L.taken.maxDrawdownPts, 100);
  assert.deepEqual([L.halves.first.totalPts, L.halves.second.totalPts], [100, 400]);
  assert.equal(L.goLive.verdict, "NOT_ENOUGH_TRADES");
  assert.equal(L.goLive.progress, "4/30");
  const met = buildCandidateLedger(days, { ...CFG, minTrades: 4 });
  assert.equal(met.goLive.verdict, "MEETS_CRITERIA");
  const failing = buildCandidateLedger(days, { ...CFG, minTrades: 4, minProfitFactor: 10 });
  assert.equal(failing.goLive.verdict, "FAILS_CRITERIA");
  // order of input days does not matter
  assert.equal(buildCandidateLedger([...days].reverse(), CFG).taken.maxDrawdownPts, 100);
});

test("both tracks, Telegram lines and the daily scorecard message", () => {
  const d = day("2026-11-23", fall, [cand({ minutes: 680, entry: 25593.9, sl: 25820.16, t1: 25367.64, t2: 25141.38 })]);
  const P = buildCandidatePaper([d], {});
  assert.equal(P.strict.taken.n, 0);
  assert.equal(P.strict.skipped.stopTooWide, 1);
  assert.equal(P.capped.taken.n, 1);
  const lines = formatCandidatePaperLines(d, CFG);
  assert.match(lines[0], /Candidate paper trades/);
  assert.match(lines[1], /not taken, stop 226\.26 pts > 120 \(own stop: \+\d+(\.\d+)?; stop capped at 120: \+\d+/);
  assert.deepEqual(formatCandidatePaperLines(day("2026-11-23", fall, []), CFG), []);
  const msg = formatDailyTelegram({ ...d, finalisedAt: "x", dataQuality: { coveragePct: 99 } });
  assert.match(msg, /Candidate paper trades/);
});

test("never throws on bad input", () => {
  assert.deepEqual(paperTradesForDay(null, CFG), []);
  assert.equal(buildCandidateLedger(null, CFG).taken.n, 0);
  const noSeries = { date: "2026-11-23", events: [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })] };
  assert.equal(paperTradesForDay(noSeries, CFG)[0].status, "UNMEASURABLE");
});

// ── review fixes (23-Nov-2026) ─────────────────────────────────────────────────────────────────
function legacyMarkdownError(text) { // same acceptance rule as test/telegramMarkdown.test.js
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && "_*`[".includes(s[i + 1])) { i++; continue; }
    if (c === "`" && s.startsWith("```", i)) { const end = s.indexOf("```", i + 3); if (end < 0) return `unclosed \`\`\` at ${i}`; i = end + 2; continue; }
    if (c === "*" || c === "_" || c === "`") { const end = s.indexOf(c, i + 1); if (end < 0) return `unclosed ${c} at ${i}: …${s.slice(Math.max(0, i - 20), i + 20)}…`; i = end; continue; }
    if (c === "[") { const m = /^\[[^\]]*\]\([^)]*\)/.exec(s.slice(i)); if (!m) return `unclosed [ at ${i}`; i += m[0].length - 1; }
  }
  return null;
}

/** Same as day() but the series stops at `lastMin` (today in progress, or a feed that stopped). */
function partialDay(date, path, events, lastMin) {
  const d = day(date, path, events);
  const k = d.series.m.findIndex((x) => x > lastMin);
  if (k > 0) for (const key of ["m", "s", "f"]) d.series[key] = d.series[key].slice(0, k);
  return d;
}

test("a position still open when the series ends is OPEN (marked to market), never a closed trade", () => {
  const evs = [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 }), cand({ minutes: 700, entry: 25580, sl: 25680, t1: 25480, t2: 25380 })];
  const d = partialDay("2026-11-23", fall, evs, 720); // 12:00, T2 (14:40) not reached yet
  const rows = paperTradesForDay(d, CFG);
  assert.equal(rows[0].status, "OPEN");
  assert.equal(rows[0].pts, null);
  assert.ok(rows[0].markPts > 0);
  assert.equal(rows[0].lastAt, "12:00");
  assert.equal(rows[1].status, "SKIPPED_POSITION_OPEN", "the open paper position still holds the slot");
  const L = buildCandidateLedger([d], CFG);
  assert.equal(L.taken.n, 0, "an open position is not in the statistics");
  assert.equal(L.open, 1);
  // the same day complete: closed at T2
  assert.equal(paperTradesForDay(day("2026-11-23", fall, evs), CFG)[0].status, "TAKEN");
});

test("real trades hold the Algo's single slot; a real signal on the same bar is not paper evidence", () => {
  const realSig = (minutes, tradeId) => ({ id: `SIGNAL:SYNERGY_BEAR:${minutes}`, minutes, time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`, section: "SIGNAL", type: "SYNERGY_BEAR", direction: "BEARISH", spot: 25620, data: { grade: "SYNERGY_BEAR", tradeId, entry: 25620, sl: 25720, t1: 25520, t2: 25420 } });
  const trade = (tradeId) => ({ section: "TRADE", type: "ENTRY", data: { tradeId } });
  // a real executed trade opened at 11:00 (660) is still open at 11:20
  const open = paperTradesForDay(day("2026-11-23", fall, [realSig(660, "T1"), trade("T1"), cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), CFG);
  assert.equal(open[0].status, "SKIPPED_REAL_TRADE_OPEN");
  // a real signal (not executed) on the same bar and side
  const dup = paperTradesForDay(day("2026-11-23", fall, [realSig(680, null), cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), CFG);
  assert.equal(dup[0].status, "DUPLICATE_OF_REAL");
  // a real signal that was NOT executed does not hold the slot
  const notExec = paperTradesForDay(day("2026-11-23", fall, [realSig(660, "T9"), cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), CFG);
  assert.equal(notExec[0].status, "TAKEN");
});

test("Telegram lines are valid legacy Markdown for every status (underscored grades and reasons)", () => {
  const cases = [
    day("2026-11-23", fall, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })]), // TAKEN, T2
    day("2026-11-23", fall, [cand({ minutes: 680, entry: 25593.9, sl: 25820.16, t1: 25367.64, t2: 25141.38 })]), // too wide
    partialDay("2026-11-23", fall, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 })], 720), // OPEN
    day("2026-11-23", fall, [cand({ minutes: 680, entry: 25600, sl: 25700, t1: 25500, t2: 25400 }), cand({ minutes: 700, entry: 25580, sl: 25680, t1: 25480, t2: 25380 })]), // skipped
  ];
  for (const d of cases) {
    const lines = formatCandidatePaperLines(d, CFG).join("\n");
    assert.equal(legacyMarkdownError(lines), null, lines);
    assert.match(lines, /`SYNERGY_BEAR_CAND`/);
  }
  const msg = formatDailyTelegram({ ...cases[0], finalisedAt: "x", dataQuality: { coveragePct: 99 } }, { candidates: false });
  assert.equal(legacyMarkdownError(msg), null);
  assert.match(msg, /`SYNERGY_BEAR_CAND`: \+200 \(`T2` 14:40\)/);
});
