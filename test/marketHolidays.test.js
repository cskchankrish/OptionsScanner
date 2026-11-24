import test from "node:test";
import assert from "node:assert/strict";
import { getSessionKindForDate, getMarketHolidays, isMarketHoliday, DEFAULT_MARKET_HOLIDAYS } from "../src/marketCalendar.js";
import { nextSessionDate, isSessionDate, reconcileEodHistory, healMisdatedResolutions, computeEodTrackStats, resolvePendingEodRows } from "../src/eodTrackRecord.js";
import { exportDates } from "../scripts/archive-export.mjs";

test("weekday exchange holidays are closed; weekends and Muhurat unchanged", () => {
  assert.equal(getSessionKindForDate("2026-11-24"), "CLOSED", "Guru Nanak Jayanti");
  assert.equal(getSessionKindForDate("2026-12-25"), "CLOSED");
  assert.equal(getSessionKindForDate("2027-01-26"), "CLOSED");
  assert.equal(getSessionKindForDate("2026-11-23"), "WEEKDAY");
  assert.equal(getSessionKindForDate("2026-11-25"), "WEEKDAY");
  assert.equal(getSessionKindForDate("2026-11-28"), "CLOSED", "Saturday");
  assert.equal(getSessionKindForDate("2026-11-08"), "MUHURAT");
  assert.ok(DEFAULT_MARKET_HOLIDAYS.includes("2026-11-24"));
  assert.equal(isMarketHoliday("2026-11-24"), true);
  assert.equal(isSessionDate("2026-11-24"), false);
});

test("MARKET_HOLIDAYS env adds holidays (server side)", () => {
  const prev = process.env.MARKET_HOLIDAYS;
  process.env.MARKET_HOLIDAYS = "2026-12-01, bad";
  try {
    assert.ok(getMarketHolidays().includes("2026-12-01"));
    assert.equal(getSessionKindForDate("2026-12-01"), "CLOSED");
  } finally {
    if (prev === undefined) delete process.env.MARKET_HOLIDAYS; else process.env.MARKET_HOLIDAYS = prev;
  }
  assert.equal(getSessionKindForDate("2026-12-01"), "WEEKDAY");
});

test("the next session after Monday 23-Nov is Wednesday 25-Nov", () => {
  assert.equal(nextSessionDate("2026-11-23"), "2026-11-25");
  assert.equal(nextSessionDate("2026-12-24"), "2026-12-28");
});

const row = (isoDate, extra = {}) => ({ id: `eod_${isoDate}`, isoDate, date: isoDate, time: "15:40 IST", verdict: "EXIT TO CASH / DO NOT CARRY", bias: "NEUTRAL", entrySpot: 25349.65, outcome: "PRESERVED_CASH", provisional: false, source: "recorded", ...extra });

test("a no-carry check graded from the holiday's fake open is re-opened and waits for 25-Nov", () => {
  const bad = row("2026-11-23", { nextDayOpen: 25349.65, openGapPts: 0, openGapPct: 0, cashCheck: "CORRECT", resolvedFrom: { date: "2026-11-24", time: "09:15", source: "timeline-open" }, notes: "No carry. Next open 25349.65" });
  const [fixed] = healMisdatedResolutions([bad]);
  assert.equal(fixed.cashCheck, undefined);
  assert.equal(fixed.nextDayOpen, null);
  assert.equal(fixed.resolvedFrom, undefined);
  assert.match(fixed.notes, /not a trading session; waiting for 2026-11-25/);
  // a correctly dated resolution is kept
  const good = row("2026-11-20", { nextDayOpen: 25929.15, cashCheck: "MISSED_UP", resolvedFrom: { date: "2026-11-23", time: "09:15" } });
  assert.deepEqual(healMisdatedResolutions([good])[0], good);
  // a carry row goes back to PENDING
  const carry = row("2026-11-23", { bias: "BEARISH", verdict: "CARRY NIFTY PE (STBT)", outcome: "WIN", nextDayOpen: 25300, gapPts: 49, resolvedFrom: { date: "2026-11-24" } });
  const c = healMisdatedResolutions([carry])[0];
  assert.equal(c.outcome, "PENDING");
  assert.equal(c.gapPts, null);
  // on 25-Nov it resolves from the real open
  const tl = [{ minutes: 555, time: "09:15", spot: 25500, isLiveTick: true }, { minutes: 556, time: "09:16", spot: 25510, isLiveTick: true }];
  const r = resolvePendingEodRows([fixed], { todayIso: "2026-11-25", todayTimeline: tl })[0];
  assert.equal(r.resolvedFrom?.date, "2026-11-25");
  assert.ok(r.nextDayOpen > 0);
});

test("on the holiday the reconcile writes no row and drops a holiday row already stored", () => {
  const hist = [row("2026-11-24", { outcome: "IN_PROGRESS", provisional: true }), row("2026-11-23", { cashCheck: "CORRECT", nextDayOpen: 25349.65, resolvedFrom: { date: "2026-11-24" } })];
  const out = reconcileEodHistory({ history: hist, todayIso: "2026-11-24", nowMins: 960, timeStr: "16:00 IST", dayName: "Tuesday", spot: 25349.65, eodDecision: { verdict: "EXIT TO CASH / DO NOT CARRY", bias: "NEUTRAL" } });
  assert.deepEqual(out.map((r) => r.isoDate), ["2026-11-23"]);
  assert.equal(out[0].cashCheck, undefined);
  const st = computeEodTrackStats(out).live;
  assert.equal(st.cashChecked, 0, "the fake check no longer counts");
});

test("the archive skips the holiday", () => {
  const nowMs = Date.parse("2026-11-25T16:30:00+05:30");
  const ds = exportDates({ nowMs, days: 5 });
  assert.ok(!ds.includes("2026-11-24"));
  assert.ok(ds.includes("2026-11-25") && ds.includes("2026-11-23"));
});

test("weekly levels: a week whose Friday is a holiday is complete after its Thursday (25-Dec-2026)", async () => {
  const { computeWeeklyOutlook } = await import("../src/weeklyOutlook.js");
  const mk = (date, c) => ({ date, source: "capture", spot: { open: c, high: c + 20, low: c - 20, close: c }, fut: { close: c + 10, oiClose: 2e5 }, chains: {} });
  const days = [["2026-12-14", 24000], ["2026-12-15", 24010], ["2026-12-16", 24020], ["2026-12-17", 24030], ["2026-12-18", 24040],
    ["2026-12-21", 24500], ["2026-12-22", 24510], ["2026-12-23", 24520], ["2026-12-24", 24530]].map(([d, c]) => mk(d, c));
  const o = computeWeeklyOutlook({ days });
  assert.equal(o.levels.prevWeek.from, "2026-12-21");
  assert.equal(o.levels.prevWeek.sessions, 4);
  assert.equal(o.levels.prevWeek.close, 24530);
  // an ordinary Thursday mid-week still uses the week before
  const o2 = computeWeeklyOutlook({ days: days.slice(0, 8) }); // last = Wed 23-Dec
  assert.equal(o2.levels.prevWeek.from, "2026-12-14");
});
