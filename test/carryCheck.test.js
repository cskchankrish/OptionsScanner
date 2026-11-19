import test from "node:test";
import assert from "node:assert/strict";
import { computeCarryMetrics, measureCarryOutcome, scoreVote, buildCarryRows, summariseCarry } from "../src/carryCheck.js";
import { createCarryCheckHandler } from "../api/carry-check.js";

// Real closing readings (swing summaries / scorecard) of 17-Nov and 18-Nov-2026.
const D17 = {
  date: "2026-11-17", spot: { high: 25499.05, low: 25277.3, close: 25387.4 }, fut: { close: 25390, oiChangePct: 4.19 },
  chains: { near: { expiry: "17-Nov-2026", dte: 0, pcr: 1.03 }, nextWeekly: { expiry: "23-Nov-2026", dte: 6, pcr: 1.1 }, monthly: { expiry: "29-Dec-2026", dte: 42, pcr: 1.26 } },
};
const D18 = {
  date: "2026-11-18", spot: { high: 25383.35, low: 25145.6, close: 25227.95 }, fut: { close: 25231.2, oiChangePct: 7.93 },
  chains: { near: { expiry: "23-Nov-2026", dte: 5, pcr: 0.86 }, nextWeekly: { expiry: "01-Dec-2026", dte: 13, pcr: 0.79 }, monthly: { expiry: "29-Dec-2026", dte: 41, pcr: 1.23 } },
};
const EOD18 = { data: { score: -1, groups: { A: -2, B: 2, C: -1 } } };

test("18-Nov close: short build-up with a large OI rise, PCR falling on the same expiry, weak close", () => {
  const m = computeCarryMetrics({ day: D18, prevDay: D17, eodFinal: EOD18, outlook: { regime: "RANGE" } });
  assert.equal(m.DAY_QUADRANT.value, "SHORT_BUILDUP");
  assert.equal(m.DAY_QUADRANT.vote, "BEARISH");
  assert.equal(m.STRONG_BUILDUP.vote, "BEARISH");
  assert.equal(m.CLOSE_IN_RANGE.value, 35);
  assert.equal(m.CLOSE_IN_RANGE.vote, "BEARISH");
  assert.equal(m.PCR_SHIFT.vote, "BEARISH");
  assert.match(m.PCR_SHIFT.detail, /23-Nov-2026 PCR 1.1 → 0.86/, "same expiry, not 23-Nov vs 01-Dec");
  assert.equal(m.WEEKLY_OUTLOOK.vote, "NEUTRAL", "the snapshot taken that day said RANGE");
  assert.equal(m.EOD_SCORE.vote, "BEARISH");
  assert.equal(m.EOD_B.vote, "BULLISH");
  assert.equal(m.BREAKDOWN_COMBO.vote, "BEARISH");
  assert.equal(m.CONFLUENCE.vote, "BEARISH");
  assert.equal(m.CONFLUENCE.value, "0 bullish / 4 bearish");
});

test("PCR change ignores an expiring chain and needs an expiry recorded on both days", () => {
  const prev = { ...D17, chains: { near: { expiry: "17-Nov-2026", dte: 0, pcr: 2.0 } } };
  const day = { ...D18, chains: { near: { expiry: "17-Nov-2026", dte: 0, pcr: 0.5 } } };
  assert.equal(computeCarryMetrics({ day, prevDay: prev }).PCR_SHIFT.vote, "NEUTRAL");
  assert.equal(computeCarryMetrics({ day: D18, prevDay: null }).PCR_SHIFT.vote, "NEUTRAL");
});

test("deadbands: a small day is no vote", () => {
  const day = { ...D18, fut: { close: 25395, oiChangePct: 0.1 } };
  const m = computeCarryMetrics({ day, prevDay: D17 });
  assert.equal(m.DAY_QUADRANT.value, "NEUTRAL_CHOP");
  assert.equal(m.DAY_DIRECTION.vote, "NEUTRAL");
  assert.equal(m.STRONG_BUILDUP.vote, "NEUTRAL");
});

// Minute series helpers: f = futures, v = cumulative futures volume.
function seriesOf(points) { return { m: points.map((p) => p[0]), f: points.map((p) => p[1]), v: points.map((p) => p[2] ?? null), s: points.map((p) => p[1] - 20) }; }
const day18 = seriesOf([[930, 25240], [935, 25236], [936, 25235], [938, 25231]]);
function next19(drop) {
  const pts = [[555, 25231.2, 6000000]]; // carry-over quote: yesterday's price and cumulative volume
  for (let m = 556; m <= 700; m++) pts.push([m, 25160 - drop * ((m - 556) / 144), 50000 + (m - 556) * 1000]);
  return seriesOf(pts);
}

test("next-morning outcome is measured from the 15:36 exit, skipping the carry-over opening quote", () => {
  const o = measureCarryOutcome({ daySeries: day18, nextSeries: next19(60), nextDate: "2026-11-19" });
  assert.equal(o.status, "MEASURED");
  assert.equal(o.refPrice, 25235);
  assert.equal(o.refAt, "15:36");
  assert.equal(o.open.at, "09:16", "09:15 repeated yesterday's quote (volume reset) and is skipped");
  assert.equal(o.open.pts, -75);
  assert.ok(o.at1030.pts < -75);
  const short = scoreVote("BEARISH", o);
  const long = scoreVote("BULLISH", o);
  assert.equal(short.hit, true);
  assert.equal(long.hit, false);
  assert.equal(short.at1030Pts, -long.at1030Pts);
  assert.equal(short.majorFor, true, "≥ 0.35% in the short's favour before 11:00");
  assert.equal(long.majorAgainst, true);
  assert.equal(scoreVote("NEUTRAL", o).status, "NO_VOTE");
});

test("pending before 10:30; unmeasurable across a futures roll or without a 15:36 tick", () => {
  const early = seriesOf([[555, 25200, 1000], [556, 25190, 2000], [600, 25180, 9000]]);
  assert.equal(measureCarryOutcome({ daySeries: day18, nextSeries: early }).status, "PENDING");
  assert.equal(measureCarryOutcome({ daySeries: day18, nextSeries: null }).status, "PENDING");
  assert.equal(measureCarryOutcome({ daySeries: day18, nextSeries: next19(10), dayExpiry: "24-Nov-2026", nextExpiry: "29-Dec-2026" }).status, "UNMEASURABLE");
  assert.equal(measureCarryOutcome({ daySeries: seriesOf([[900, 25200]]), nextSeries: next19(10) }).status, "UNMEASURABLE");
});

test("rows pair each day with the next recorded session; summary counts votes and major moves", () => {
  const rows = buildCarryRows({
    swingDays: [D17, D18],
    scDocs: { "2026-11-18": { date: "2026-11-18", series: day18, eodFinal: EOD18 }, "2026-11-19": { date: "2026-11-19", series: next19(60) } },
    outlooks: { "2026-11-18": { regime: "TREND_DOWN" } },
  });
  const r18 = rows.find((r) => r.date === "2026-11-18");
  assert.equal(r18.outcome.nextDate, "2026-11-19");
  assert.equal(r18.metrics.WEEKLY_OUTLOOK.vote, "BEARISH", "uses the outlook stored for that date");
  assert.equal(r18.scores.STRONG_BUILDUP.hit, true);
  assert.equal(r18.scores.EOD_B.hit, false);
  const s = summariseCarry(rows);
  assert.equal(s.measuredSessions, 1);
  assert.equal(s.majorMoveSessions, 1);
  assert.equal(s.byMetric.CONFLUENCE.majorMovesCalled, 1);
  assert.equal(s.byMetric.EOD_B.majorAgainst, 1);
  assert.equal(s.byMetric.CONFLUENCE.tooFewToJudge, true);
});

test("API: read-only, today's live timeline stands in as the next session", async () => {
  const store = {
    "nifty:swing:day:2026-11-17": D17,
    "nifty:swing:day:2026-11-18": D18,
    "nifty:swing:outlook:2026-11-18": { regime: "RANGE" },
    "nifty:sc:day:2026-11-18": { date: "2026-11-18", series: day18, eodFinal: EOD18, events: [{ id: "x" }] },
  };
  const calls = { mget: 0, timeline: 0 };
  const handler = createCarryCheckHandler({
    now: () => Date.parse("2026-11-19T06:00:00Z"), // 11:30 IST
    mget: async (ks) => { calls.mget++; return ks.map((k) => store[k] ?? null); },
    getTimeline: async (d) => {
      calls.timeline++;
      if (d !== "2026-11-19") return [];
      const sr = next19(60);
      return sr.m.map((m, i) => ({ minutes: m, futPrice: sr.f[i], futVolume: sr.v[i], spot: sr.s[i], isLiveTick: true }));
    },
    env: () => ({}),
  });
  let out = null;
  const res = { setHeader() {}, status() { return this; }, json(b) { out = b; return this; }, end() { return this; } };
  await handler({ method: "GET", query: { days: "10" } }, res);
  assert.equal(out.ok, true);
  assert.equal(out.shadow, true);
  const r18 = out.sessions.find((r) => r.date === "2026-11-18");
  assert.equal(r18.outcome.status, "MEASURED");
  assert.equal(r18.metrics.CONFLUENCE.vote, "BEARISH");
  assert.equal(calls.timeline, 1);
  assert.ok(out.summary.byMetric.BREAKDOWN_COMBO);
});

// ── exit policies (owner 2026-11-19) ──────────────────────────────────────────────────────────
import { runExitPolicy, CARRY_EXIT_POLICIES } from "../src/carryCheck.js";
const POL = Object.fromEntries(CARRY_EXIT_POLICIES.map((p) => [p.key, p]));
const ticksOf = (pairs) => pairs.map(([minutes, f]) => ({ minutes, f }));

// 19-Nov shape, from 18-Nov's 15:36 price 25231: down to 25100 by 09:31, back to 25236 by 09:54.
function nov19() {
  const out = [];
  for (let m = 556; m <= 630; m++) {
    // real path: 25155 at 09:16, 25100 at 09:31, 25216.5 at 09:45, 25236 at 09:54
    const f = m <= 571 ? 25155 - (m - 556) * 3.66 : m <= 585 ? 25100 + (m - 571) * 8.32 : m <= 594 ? 25216.5 + (m - 585) * 2.17 : 25236 + (m - 594) * 0.5;
    out.push([m, Math.round(f * 100) / 100]);
  }
  return ticksOf(out);
}

test("19-Nov shape: a held short keeps the drop with a target, gives it back on a clock", () => {
  const t = nov19();
  const ref = 25231;
  const at0945 = runExitPolicy(t, ref, -1, POL.TIME_0945);
  const br35 = runExitPolicy(t, ref, -1, POL.BRACKET_035_025);
  const br50 = runExitPolicy(t, ref, -1, POL.BRACKET_050_030);
  assert.equal(at0945.exit, "TIME");
  assert.ok(at0945.pts < 30, "the bounce has taken most of it back by 09:45");
  assert.equal(br35.exit, "TARGET");
  assert.ok(br35.pts >= 88, "0.35% of 25231 = 88 pts, kept");
  assert.equal(br50.exit, "TARGET");
  assert.ok(br50.pts >= 126);
  // the wrong-way long is stopped at the open instead of riding the drop
  const longBr = runExitPolicy(t, ref, 1, POL.BRACKET_035_025);
  assert.equal(longBr.exit, "STOP");
  assert.equal(longBr.at, "09:16");
});

test("a gap through the stop at the open fills at the open price", () => {
  const r = runExitPolicy(ticksOf([[556, 24900], [557, 25300]]), 25000, 1, POL.BRACKET_050_030);
  assert.equal(r.exit, "STOP");
  assert.equal(r.pts, -100, "not −75 (the 0.30% stop level): the open was already beyond it");
});

test("a time exit waits for its minute; before then it is pending", () => {
  const early = ticksOf([[556, 25010], [570, 25020]]);
  assert.equal(runExitPolicy(early, 25000, 1, POL.TIME_0945).status, "PENDING");
  assert.equal(runExitPolicy(early, 25000, 1, POL.BRACKET_035_025).status, "PENDING");
});

test("each vote is scored under every policy, and summarised per policy", () => {
  const daySer = seriesOf([[930, 25240], [936, 25231]]);
  const t = nov19();
  const nextSer = { m: [555, ...t.map((x) => x.minutes)], f: [25231, ...t.map((x) => x.f)], v: [6000000, ...t.map((_, i) => 50000 + i * 1000)], s: [25200, ...t.map((x) => x.f - 20)] };
  const o = measureCarryOutcome({ daySeries: daySer, nextSeries: nextSer });
  assert.equal(o.status, "MEASURED");
  for (const p of CARRY_EXIT_POLICIES) assert.ok(o.policies[p.key].long && o.policies[p.key].short);
  const short = scoreVote("BEARISH", o);
  assert.equal(short.policies.BRACKET_035_025.hit, true);
  assert.equal(short.policies.BRACKET_035_025.exit, "TARGET");
  const rows = buildCarryRows({ swingDays: [D17, D18], scDocs: { "2026-11-18": { date: "2026-11-18", series: daySer, eodFinal: EOD18 }, "2026-11-19": { date: "2026-11-19", series: nextSer } } });
  const bp = summariseCarry(rows).byMetric.CONFLUENCE.byPolicy;
  assert.equal(bp.BRACKET_035_025.hits, 1);
  assert.equal(bp.BRACKET_035_025.targets, 1);
  assert.equal(Object.keys(bp).length, 4);
});

test("before 10:30 the outcome is pending but already carries the policies that resolved", () => {
  const daySer = seriesOf([[930, 25240], [936, 25231]]);
  const t = nov19().filter((x) => x.minutes <= 580);
  const nextSer = { m: [555, ...t.map((x) => x.minutes)], f: [25231, ...t.map((x) => x.f)], v: [6000000, ...t.map((_, i) => 50000 + i * 1000)], s: [25200, ...t.map((x) => x.f - 20)] };
  const o = measureCarryOutcome({ daySeries: daySer, nextSeries: nextSer });
  assert.equal(o.status, "PENDING");
  assert.equal(o.policies.BRACKET_035_025.short.exit, "TARGET");
  assert.equal(o.policies.TIME_1030.short.status, "PENDING");
});
