/**
 * EOD Track Record integrity (src/eodTrackRecord.js): session-date filtering, today's row
 * lifecycle (IN_PROGRESS → final → resolved), resolution from the next session's opening tick,
 * the one-off repair of the stored production rows, and the recorded-live vs hand-entered stats.
 * Pure functions only, plus one POST sync through the handler with Redis disabled. No network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "MUHURAT_DATES",
]) delete process.env[k];

const {
  CANONICAL_EOD_SEED_HISTORY,
  isSessionDate,
  mergeEodHistory,
  sanitizeEodHistory,
  eodRowsForStorage,
  buildTodayEodRow,
  reconcileEodHistory,
  resolvePendingEodRows,
  repairEodHistory,
  runEodHistoryRepairOnce,
  computeEodTrackStats,
  formatEodWinRate,
  sessionOpenTick,
  sessionClosingPrint,
  frozenWindowSpot,
  repairEodHistoryV2,
  parseV1EntryChange,
  isSeedRow,
  eodUnresolvedLabel,
} = await import("../src/eodTrackRecord.js");

const NEUTRAL = { verdict: "EXIT TO CASH / DO NOT CARRY", bias: "NEUTRAL", score: 0, conviction: null, sizing: "0% (Cash Only)", isClosingDataValid: true, audit: [] };
const BTST = { verdict: "CARRY NIFTY CE (BTST)", bias: "BULLISH", score: 4, conviction: 80, sizing: "75% Normal Size", isClosingDataValid: true, audit: [] };
const STBT = { verdict: "CARRY NIFTY PE (STBT)", bias: "BEARISH", score: -4, conviction: 80, sizing: "75% Normal Size", isClosingDataValid: true, audit: [] };

const tick = (time, spot, extra = {}) => {
  const [h, m] = time.split(":").map(Number);
  return { time, minutes: h * 60 + m, spot, putWriting: 0, callWriting: 0, netDiff: 0, isLiveTick: true, ...extra };
};

function row(isoDate, verdict, outcome, entrySpot, extra = {}) {
  const bias = verdict.includes("BTST") ? "BULLISH" : verdict.includes("STBT") ? "BEARISH" : "NEUTRAL";
  return { id: `eod_${isoDate}`, isoDate, verdict, bias, outcome, entrySpot, nextDayOpen: null, gapPts: null, notes: "Decision finalized on closing settlement (15:40 IST).", ...extra };
}

const CASH = "EXIT TO CASH / DO NOT CARRY";
const CE = "CARRY NIFTY CE (BTST)";
const PE = "CARRY NIFTY PE (STBT)";

// The production rows (newest first) as served on 16-Nov-2026, followed by the seed rows.
function productionFixture() {
  const recorded = [
    row("2026-11-16", CASH, "PRESERVED_CASH", 25283.9, { notes: "Intraday monitoring snapshot." }),
    row("2026-11-15", CASH, "PRESERVED_CASH", 25144.3),
    row("2026-11-13", CASH, "PRESERVED_CASH", 25144.3),
    row("2026-11-12", CE, "PRESERVED_CASH", 25299.35),
    row("2026-11-11", PE, "PRESERVED_CASH", 25255.05),
    row("2026-11-10", CASH, "PRESERVED_CASH", 25044.65),
    row("2026-11-09", CE, "PRESERVED_CASH", 25044.65),
    row("2026-11-08", PE, "PRESERVED_CASH", 24986.4),
    row("2026-11-07", CASH, "PRESERVED_CASH", 25030.35),
  ];
  const seed6 = CANONICAL_EOD_SEED_HISTORY.find(r => r.isoDate === "2026-11-06");
  const { source: _s, ...seed6NoSource } = seed6;
  const nov6 = { ...seed6NoSource, outcome: "LOSS", nextDayOpen: 25030.35, gapPts: 0, notes: "+0 pts morning gap on open" };
  const seeds = CANONICAL_EOD_SEED_HISTORY.filter(r => r.isoDate !== "2026-11-06").map(r => {
    const { source, ...rest } = r; // stored rows predate the `source` field
    return { ...rest };
  });
  return [...recorded, nov6, ...seeds];
}

// Spot frozen during the 15:15–15:30 closing auction; the closing print appears after 15:30.
function frozenRun(from, to, spot, extra = {}) {
  const out = [];
  for (let m = from; m <= to; m++) out.push(tick(`15:${String(m).padStart(2, "0")}`, spot, extra));
  return out;
}

// Injected timelines in the recorded production shapes:
// 11-Nov: 15:16–15:25 frozen at 25130 (NOT flagged — older day), close print 25255.05 at 15:36.
// 12-Nov: opens 25213.5; 15:17–15:28 frozen at 25275.25 (flagged), close print 25299.35 at 15:31.
// 13-Nov: opens 25209.85, close print 25144.3. 09-Nov: only frozen-window ticks (no print).
// Nothing recorded for 08 or 10-Nov.
const TIMELINES = {
  // 09-Nov recording started late (11:00), so it carries no usable opening tick for 08-Nov.
  "2026-11-09": [tick("11:00", 24990), ...frozenRun(20, 29, 25003.65, { spotFrozen: true })],
  "2026-11-11": [tick("09:15", 25180), tick("12:00", 25230), ...frozenRun(16, 25, 25130), tick("15:36", 25255.05), tick("15:40", 25260, { isLiveTick: false })],
  "2026-11-12": [
    tick("09:15", 99999, { synthetic: true, isLiveTick: false }),
    tick("09:15", 88888, { isLiveTick: false }),
    tick("09:15", 25213.5),
    tick("11:00", 25260),
    ...frozenRun(17, 28, 25275.25, { spotFrozen: true }),
    tick("15:31", 25299.35),
  ],
  "2026-11-13": [tick("09:15", 25209.85), tick("13:00", 25180), tick("15:31", 25144.3)],
};
const getTimelineForDate = async (iso) => TIMELINES[iso] || [];

// ── Session dates ────────────────────────────────────────────────────────────

test("isSessionDate: weekdays and the Muhurat date are sessions, closed weekend dates are not", () => {
  assert.equal(isSessionDate("2026-11-16"), true); // Monday
  assert.equal(isSessionDate("2026-11-13"), true); // Friday
  assert.equal(isSessionDate("2026-11-08"), true); // Sunday Muhurat
  assert.equal(isSessionDate("2026-11-07"), false); // Saturday
  assert.equal(isSessionDate("2026-11-15"), false); // ordinary Sunday
  assert.equal(isSessionDate("not-a-date"), false);
});

test("mergeEodHistory drops closed-weekend rows from server and local, keeps the Muhurat row", () => {
  const server = [row("2026-11-15", CASH, "PRESERVED_CASH", 1), row("2026-11-08", PE, "PENDING", 24986.4), row("2026-11-07", CASH, "PRESERVED_CASH", 2)];
  const local = [row("2026-11-14", CASH, "PRESERVED_CASH", 3), row("2026-11-06", CE, "PENDING", 25030.35)];
  const merged = mergeEodHistory(local, server);
  assert.deepEqual(merged.map(r => r.isoDate), ["2026-11-08", "2026-11-06"]);
});

test("mergeEodHistory: a local cash outcome never overrides a server PENDING carry; a local WIN/LOSS fills an open server row", () => {
  const server = [row("2026-11-12", CE, "PENDING", 25299.35), row("2026-11-11", PE, "UNRESOLVED", 25255.05)];
  const local = [row("2026-11-12", CE, "PRESERVED_CASH", 25299.35), row("2026-11-11", PE, "WIN", 25255.05, { nextDayOpen: 25213.5, gapPts: 41.55 })];
  const merged = mergeEodHistory(local, server);
  assert.equal(merged.find(r => r.isoDate === "2026-11-12").outcome, "PENDING");
  const r11 = merged.find(r => r.isoDate === "2026-11-11");
  assert.equal(r11.outcome, "WIN");
  assert.equal(r11.gapPts, 41.55);
});

test("server step (reconcileEodHistory) drops non-session rows; on a closed day it records nothing", () => {
  const history = [row("2026-11-15", CASH, "PRESERVED_CASH", 1), row("2026-11-13", CASH, "PRESERVED_CASH", 25144.3), row("2026-11-07", CASH, "PRESERVED_CASH", 2), row("2026-11-08", PE, "UNRESOLVED", 24986.4)];
  const out = reconcileEodHistory({ history, todayIso: "2026-11-16", nowMins: 600, timeStr: "10:00 IST", dayName: "Monday", spot: 25300, eodDecision: NEUTRAL });
  assert.deepEqual(out.map(r => r.isoDate), ["2026-11-16", "2026-11-13", "2026-11-08"]);
  // Saturday: no today row, weekend rows still dropped.
  const sat = reconcileEodHistory({ history, todayIso: "2026-11-14", nowMins: 600, timeStr: "10:00 IST", dayName: "Saturday", spot: 25300, eodDecision: NEUTRAL });
  assert.deepEqual(sat.map(r => r.isoDate), ["2026-11-13", "2026-11-08"]);
});

test("POST sync_eod_history drops non-session rows before saving", async () => {
  process.env.TV_WEBHOOK_SECRET = "eod-sync-test-secret";
  try {
    const { default: handler } = await import("../api/nifty-oi.js");
    const res = {
      statusCode: 200, body: null,
      setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; },
    };
    const history = [row("2026-11-15", CASH, "PRESERVED_CASH", 1), row("2026-11-13", CASH, "PRESERVED_CASH", 25144.3), row("2026-11-07", CASH, "PRESERVED_CASH", 2), row("2026-11-08", PE, "PENDING", 24986.4)];
    await handler({ method: "POST", query: {}, headers: { "x-webhook-secret": "eod-sync-test-secret" }, body: JSON.stringify({ action: "sync_eod_history", history }) }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 2);
  } finally {
    delete process.env.TV_WEBHOOK_SECRET;
  }
});

test("client today row is not built on a Saturday or an ordinary Sunday (built on the Muhurat Sunday)", () => {
  const args = { nowMins: 900, timeStr: "15:00 IST", dayName: "x", spot: 25000, floorStrike: 24900, roofStrike: 25100, eodDecision: BTST };
  assert.equal(buildTodayEodRow({ ...args, todayIso: "2026-11-14" }), null);
  assert.equal(buildTodayEodRow({ ...args, todayIso: "2026-11-15" }), null);
  assert.ok(buildTodayEodRow({ ...args, todayIso: "2026-11-08" }));
  assert.equal(buildTodayEodRow({ ...args, todayIso: "2026-11-16", nowMins: 500 }), null, "nothing before the open");
});

test("eodRowsForStorage drops weekend and provisional rows", () => {
  const rows = [
    { ...row("2026-11-16", BTST.verdict, "IN_PROGRESS", 25300), provisional: true },
    row("2026-11-15", CASH, "PRESERVED_CASH", 1),
    row("2026-11-13", CASH, "PRESERVED_CASH", 25144.3),
  ];
  assert.deepEqual(eodRowsForStorage(rows).map(r => r.isoDate), ["2026-11-13"]);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Default: a real NSE spot with a current data time (the finalisation guard is satisfied).
function step(existing, nowMins, spot, eodDecision, todayIso = "2026-11-16", guard = { spotIsReal: true, nseDataMins: nowMins }) {
  return buildTodayEodRow({ todayIso, nowMins, timeStr: `${Math.floor(nowMins / 60)}:${String(nowMins % 60).padStart(2, "0")} IST`, dayName: "Monday", spot, floorStrike: 25000, roofStrike: 25400, eodDecision, existing, ...guard });
}

test("lifecycle: a day that starts NEUTRAL then turns BTST ends PENDING (not PRESERVED_CASH)", () => {
  let r = step(null, 560, 25200, NEUTRAL);
  assert.equal(r.outcome, "IN_PROGRESS");
  assert.equal(r.provisional, true);
  assert.equal(r.notes, "session in progress — verdict not final");
  r = step(r, 900, 25250, BTST);
  assert.equal(r.outcome, "IN_PROGRESS", "still not final at 15:00");
  r = step(r, 937, 25260, BTST);
  assert.equal(r.outcome, "IN_PROGRESS", "still not final at 15:37");
  r = step(r, 938, 25270, BTST);
  assert.equal(r.outcome, "PENDING");
  assert.equal(r.provisional, false);
  assert.equal(r.entrySpot, 25270);
  assert.equal(r.source, "recorded");
});

test("lifecycle: BTST during the day, back to NEUTRAL before finalisation → PRESERVED_CASH", () => {
  let r = step(null, 600, 25200, BTST);
  r = step(r, 920, 25210, BTST);
  r = step(r, 938, 25190, NEUTRAL);
  assert.equal(r.outcome, "PRESERVED_CASH");
  assert.equal(r.bias, "NEUTRAL");
});

test("lifecycle: entrySpot frozen after finalisation; invalid post-market data does not overwrite the final verdict", () => {
  let r = step(null, 938, 25270, STBT);
  assert.equal(r.outcome, "PENDING");
  r = step(r, 939, 25290, STBT);
  assert.equal(r.entrySpot, 25270, "frozen at the first final snapshot");
  const invalid = { ...NEUTRAL, isClosingDataValid: false };
  const after = step(r, 1100, 25300, invalid);
  assert.equal(after.verdict, STBT.verdict);
  assert.equal(after.outcome, "PENDING");
  assert.equal(after.entrySpot, 25270);
  // An earlier-than-final request (e.g. another instance) never downgrades a final row.
  assert.equal(step(r, 700, 25000, NEUTRAL), r);
  // A later VALID recomputation may change the verdict; the outcome follows the new bias, entry stays frozen.
  const valid = step(r, 1100, 25300, NEUTRAL);
  assert.equal(valid.outcome, "PRESERVED_CASH");
  assert.equal(valid.entrySpot, 25270);
});

test("lifecycle: Muhurat date finalises at 15:58", () => {
  assert.equal(step(null, 950, 24990, STBT, "2026-11-08").outcome, "IN_PROGRESS");
  assert.equal(step(null, 958, 24986.4, STBT, "2026-11-08").outcome, "PENDING");
});

// ── Finalisation guard: real spot + post-freeze NSE data time ───────────────

const FAKE = 25030.35; // api/nifty-oi.js display fallback when NSE omits underlyingValue
const g = (spotIsReal, nseDataMins) => ({ spotIsReal, nseDataMins });

test("nseTimestampIstMinutes parses the NSE format; null when missing, malformed or another date", async () => {
  const { nseTimestampIstMinutes } = await import("../src/eodTrackRecord.js");
  assert.equal(nseTimestampIstMinutes("16-Nov-2026 15:35:19"), 935);
  assert.equal(nseTimestampIstMinutes("16-Nov-2026 15:35:19", "2026-11-16"), 935);
  assert.equal(nseTimestampIstMinutes("13-Nov-2026 15:30:00", "2026-11-16"), null, "a previous day's data is not today's close");
  assert.equal(nseTimestampIstMinutes(undefined), null);
  assert.equal(nseTimestampIstMinutes("3:38:00 pm"), null);
});

test("guard: finalises normally at 15:38 with a real spot and NSE data time 15:35", () => {
  let r = step(null, 900, 25250, BTST, "2026-11-16", g(true, 899));
  r = step(r, 938, 25270, BTST, "2026-11-16", g(true, 935));
  assert.equal(r.outcome, "PENDING");
  assert.equal(r.provisional, false);
  assert.equal(r.entrySpot, 25270);
  assert.equal(r.entryUnverified, undefined);
});

test("guard: a fake spot at 15:38 keeps the row IN_PROGRESS; a real one at 15:39 finalises it", () => {
  let r = step(null, 930, 25260, BTST, "2026-11-16", g(true, 930));
  r = step(r, 938, FAKE, BTST, "2026-11-16", g(false, 935));
  assert.equal(r.outcome, "IN_PROGRESS");
  assert.equal(r.provisional, true);
  assert.equal(r.entrySpot, 25260, "a non-real spot never overwrites the recorded real one");
  r = step(r, 939, 25275, BTST, "2026-11-16", g(true, 936));
  assert.equal(r.outcome, "PENDING");
  assert.equal(r.entrySpot, 25275);
  assert.equal(r.entryUnverified, undefined);
});

test("guard: NSE data time 15:20 at 15:38 does not finalise (stale pre-15:30 response)", () => {
  const r = step(null, 938, 25270, STBT, "2026-11-16", g(true, 920));
  assert.equal(r.outcome, "IN_PROGRESS");
  assert.equal(r.provisional, true);
  assert.equal(r.entrySpot, 25270, "display only while in progress");
  // A later refresh with post-freeze data finalises.
  const f = step(r, 940, 25280, STBT, "2026-11-16", g(true, 931));
  assert.equal(f.outcome, "PENDING");
  assert.equal(f.entrySpot, 25280);
});

test("guard: unknown NSE time is not finalised until more than 10 minutes after the close, then entryUnverified", () => {
  let r = step(null, 938, 25270, BTST, "2026-11-16", g(true, null));
  assert.equal(r.outcome, "IN_PROGRESS");
  r = step(r, 945, 25272, BTST, "2026-11-16", g(true, null));
  assert.equal(r.outcome, "IN_PROGRESS");
  r = step(r, 950, 25273, BTST, "2026-11-16", g(true, null));
  assert.equal(r.outcome, "IN_PROGRESS", "15:50 is not yet more than 10 minutes past 15:40");
  r = step(r, 951, FAKE, BTST, "2026-11-16", g(false, null));
  assert.equal(r.outcome, "PENDING");
  assert.equal(r.provisional, false);
  assert.equal(r.entrySpot, 25273, "best available real spot");
  assert.equal(r.entryUnverified, true);
  assert.match(r.notes, /Entry unverified/);
  assert.match(r.notes, /NSE sent no underlying value/);
  // Frozen afterwards; a later non-verified refresh changes nothing.
  assert.equal(step(r, 955, FAKE, BTST, "2026-11-16", g(false, null)), r);
});

test("guard: a spot that was never real → entrySpot null; carry UNRESOLVED, cash PRESERVED_CASH, both entryUnverified", () => {
  let carry = step(null, 900, FAKE, BTST, "2026-11-16", g(false, 900));
  assert.equal(carry.entrySpot, null);
  carry = step(carry, 938, FAKE, BTST, "2026-11-16", g(false, 935));
  assert.equal(carry.outcome, "IN_PROGRESS");
  carry = step(carry, 951, FAKE, BTST, "2026-11-16", g(false, 951));
  assert.equal(carry.outcome, "UNRESOLVED");
  assert.equal(carry.provisional, false);
  assert.equal(carry.entrySpot, null);
  assert.equal(carry.entryUnverified, true);
  assert.equal(eodUnresolvedLabel(carry), "Entry not recorded");
  let cash = step(null, 938, FAKE, NEUTRAL, "2026-11-16", g(false, 935));
  assert.equal(cash.outcome, "IN_PROGRESS");
  cash = step(cash, 960, FAKE, NEUTRAL, "2026-11-16", g(false, 958));
  assert.equal(cash.outcome, "PRESERVED_CASH");
  assert.equal(cash.entrySpot, null);
  assert.equal(cash.entryUnverified, true);
  // A real spot after the fallback fills the empty entry (still unverified: data time unknown).
  const filled = step(carry, 955, 25290, BTST, "2026-11-16", g(true, null));
  assert.equal(filled.entrySpot, 25290);
  assert.equal(filled.outcome, "PENDING");
  assert.equal(filled.entryUnverified, true);
});

test("guard: entrySpot never becomes the 25030.35 fallback; reconcileEodHistory passes the facts through", () => {
  const seen = [];
  let r = null;
  for (const [mins, spot, real, data] of [[600, FAKE, false, 600], [930, 25260, true, 930], [938, FAKE, false, 935], [940, 25250, true, 920], [945, FAKE, false, null], [951, FAKE, false, null]]) {
    r = step(r, mins, spot, BTST, "2026-11-16", g(real, data));
    seen.push(r.entrySpot);
  }
  assert.ok(!seen.includes(FAKE), JSON.stringify(seen));
  const hist = [{ ...row("2026-11-16", CE, "IN_PROGRESS", 25260), provisional: true }];
  const out = reconcileEodHistory({ history: hist, todayIso: "2026-11-16", nowMins: 938, timeStr: "15:38 IST", dayName: "Monday", spot: FAKE, eodDecision: BTST, spotIsReal: false, nseDataMins: 935 });
  const t = out.find(x => x.isoDate === "2026-11-16");
  assert.equal(t.outcome, "IN_PROGRESS");
  assert.equal(t.entrySpot, 25260);
  const ok = reconcileEodHistory({ history: out, todayIso: "2026-11-16", nowMins: 939, timeStr: "15:39 IST", dayName: "Monday", spot: 25265, eodDecision: BTST, spotIsReal: true, nseDataMins: 936 });
  assert.equal(ok.find(x => x.isoDate === "2026-11-16").outcome, "PENDING");
  assert.equal(ok.find(x => x.isoDate === "2026-11-16").entrySpot, 25265);
});

test("guard: Muhurat date needs NSE data at or after 15:50 (same margin before its 15:58 finalisation)", () => {
  assert.equal(step(null, 958, 24986.4, STBT, "2026-11-08", g(true, 949)).outcome, "IN_PROGRESS");
  assert.equal(step(null, 958, 24986.4, STBT, "2026-11-08", g(true, 950)).outcome, "PENDING");
  assert.equal(step(null, 970, 24986.4, STBT, "2026-11-08", g(true, 949)).outcome, "IN_PROGRESS");
  const fb = step(null, 971, 24986.4, STBT, "2026-11-08", g(true, 949));
  assert.equal(fb.outcome, "PENDING");
  assert.equal(fb.entryUnverified, true);
});

test("a past row still IN_PROGRESS becomes UNRESOLVED (verdict never finalised) and is not scored", () => {
  const history = [{ ...row("2026-11-13", CE, "IN_PROGRESS", 25144.3), provisional: true, time: "15:20 IST" }];
  const out = reconcileEodHistory({ history, todayIso: "2026-11-16", nowMins: 600, timeStr: "10:00 IST", dayName: "Monday", spot: 25300, eodDecision: NEUTRAL, todayTimeline: [tick("09:15", 25300)] });
  const r13 = out.find(r => r.isoDate === "2026-11-13");
  assert.equal(r13.outcome, "UNRESOLVED");
  assert.equal(r13.provisional, false);
  assert.equal(eodUnresolvedLabel(r13), "Verdict not final");
});

// ── Resolution ───────────────────────────────────────────────────────────────

test("resolution: from the next session's first REAL tick (synthetic and isLiveTick:false ignored), never a later spot", () => {
  const history = [row("2026-11-13", CE, "PENDING", 25144.3)];
  const todayTimeline = [
    tick("09:15", 1, { synthetic: true, isLiveTick: false }),
    tick("09:15", 2, { isLiveTick: false }),
    tick("09:16", 25180.1),
    tick("10:30", 26000),
  ];
  const out = reconcileEodHistory({ history, todayIso: "2026-11-16", nowMins: 630, timeStr: "10:30 IST", dayName: "Monday", spot: 26000, eodDecision: NEUTRAL, todayTimeline });
  const r = out.find(x => x.isoDate === "2026-11-13");
  assert.equal(r.outcome, "WIN");
  assert.equal(r.nextDayOpen, 25180.1);
  assert.equal(r.gapPts, 35.8);
  assert.deepEqual(r.resolvedFrom, { date: "2026-11-16", time: "09:16", source: "timeline-open" });
  assert.equal(r.notes, "+35.8 pts morning gap on open");
});

test("resolution: BTST loss, STBT win and STBT loss with the existing sign conventions", () => {
  const tl = [tick("09:15", 25000)];
  const r = (verdict, entry) => resolvePendingEodRows([row("2026-11-13", verdict, "PENDING", entry)], { todayIso: "2026-11-16", todayTimeline: tl })[0];
  const btstLoss = r(CE, 25100);
  assert.equal(btstLoss.outcome, "LOSS");
  assert.equal(btstLoss.gapPts, -100);
  const stbtWin = r(PE, 25100);
  assert.equal(stbtWin.outcome, "WIN");
  assert.equal(stbtWin.gapPts, 100);
  assert.equal(stbtWin.notes, "+100 pts gap-down on open");
  const stbtLoss = r(PE, 24900);
  assert.equal(stbtLoss.outcome, "LOSS");
  assert.equal(stbtLoss.gapPts, -100);
});

test("resolution: stays PENDING while the next session has no usable tick; a first tick long after the open is not the open", () => {
  const pending = [row("2026-11-13", CE, "PENDING", 25144.3)];
  const none = resolvePendingEodRows(pending, { todayIso: "2026-11-16", todayTimeline: [tick("09:15", 3, { synthetic: true })] });
  assert.equal(none[0].outcome, "PENDING");
  assert.equal(none[0].nextDayOpen, null);
  const late = resolvePendingEodRows(pending, { todayIso: "2026-11-16", todayTimeline: [tick("11:05", 25300)] });
  assert.equal(late[0].outcome, "UNRESOLVED");
});

test("resolution: EVERY pending row is resolved from its own next session (not only the first three rows)", () => {
  const history = [
    row("2026-11-13", CE, "PENDING", 25100),
    row("2026-11-12", CE, "PENDING", 25200),
    row("2026-11-11", PE, "PENDING", 25255.05),
    row("2026-11-10", CASH, "PRESERVED_CASH", 25000),
    row("2026-11-09", CE, "PENDING", 25000),
  ];
  const out = resolvePendingEodRows(history, {
    todayIso: "2026-11-16",
    todayTimeline: [tick("09:15", 25150)],
    timelinesByDate: { "2026-11-13": TIMELINES["2026-11-13"], "2026-11-12": TIMELINES["2026-11-12"], "2026-11-10": [tick("09:15", 25050)] },
  });
  const by = Object.fromEntries(out.map(r => [r.isoDate, r]));
  assert.equal(by["2026-11-13"].outcome, "WIN"); // 25150 vs 25100
  assert.equal(by["2026-11-12"].outcome, "WIN"); // 25209.85 vs 25200
  assert.equal(by["2026-11-11"].outcome, "WIN"); // 25213.5 vs 25255.05 (STBT)
  assert.equal(by["2026-11-09"].outcome, "WIN"); // 25050 vs 25000
  // Next session already over and its timeline not supplied → UNRESOLVED.
  const noTl = resolvePendingEodRows([row("2026-11-11", PE, "PENDING", 25255.05)], { todayIso: "2026-11-16", todayTimeline: [] });
  assert.equal(noTl[0].outcome, "UNRESOLVED");
  // Seed rows are never auto-resolved.
  const seed = CANONICAL_EOD_SEED_HISTORY.find(r => r.isoDate === "2026-11-06");
  assert.equal(resolvePendingEodRows([seed], { todayIso: "2026-11-16", todayTimeline: [] })[0], seed);
});

test("timeline helpers: open tick; closing print from the production shapes; Muhurat → null", () => {
  assert.equal(sessionOpenTick(TIMELINES["2026-11-12"], "2026-11-12").spot, 25213.5);
  assert.equal(sessionClosingPrint(TIMELINES["2026-11-11"], "2026-11-11").spot, 25255.05);
  assert.equal(sessionClosingPrint(TIMELINES["2026-11-12"], "2026-11-12").spot, 25299.35);
  const muhurat = [tick("14:00", 24950), tick("15:30", 24970), tick("16:00", 24986.4)];
  assert.equal(sessionClosingPrint(muhurat, "2026-11-08"), null, "Muhurat: stored entry is kept");
  assert.equal(sessionOpenTick([], "2026-11-12"), null);
});

test("closing-print picker: flagged frozen window then 15:31 → 15:31 value", () => {
  const tl = [tick("14:00", 25100), ...frozenRun(15, 29, 25000, { spotFrozen: true }), tick("15:31", 25050.5)];
  const p = sessionClosingPrint(tl, "2026-11-12");
  assert.equal(p.spot, 25050.5);
  assert.equal(p.time, "15:31");
});

test("closing-print picker: unflagged repeated value then 15:36 (the 11-Nov shape) → 15:36 value; a post-15:30 tick still showing the frozen value is skipped", () => {
  const tl = [...frozenRun(16, 25, 25130), tick("15:30", 25130), tick("15:36", 25255.05)];
  assert.equal(sessionClosingPrint(tl, "2026-11-11").spot, 25255.05);
  const stillFrozen = [...frozenRun(16, 25, 25130), tick("15:31", 25130)];
  assert.equal(sessionClosingPrint(stillFrozen, "2026-11-11"), null);
});

test("closing-print picker: only freeze-window ticks → null; synthetic / isLiveTick:false / spotFrozen ignored", () => {
  assert.equal(sessionClosingPrint(frozenRun(15, 29, 25000), "2026-11-12"), null);
  assert.equal(sessionClosingPrint([tick("15:10", 25010), ...frozenRun(15, 29, 25000, { spotFrozen: true })], "2026-11-12"), null, "never a pre-15:30 tick");
  const noise = [
    ...frozenRun(15, 29, 25000, { spotFrozen: true }),
    tick("15:33", 25040),
    tick("15:35", 1, { synthetic: true }),
    tick("15:38", 2, { isLiveTick: false }),
    tick("15:39", 3, { spotFrozen: true }),
    tick("15:45", 4), // after the 15:40 close
  ];
  assert.equal(sessionClosingPrint(noise, "2026-11-12").spot, 25040);
  assert.equal(frozenWindowSpot(noise), 25000);
});

// ── Repair ───────────────────────────────────────────────────────────────────

test("repair on the production rows: weekend rows gone, 11/12-Nov scored, 08/09-Nov UNRESOLVED, seed rows untouched", async () => {
  const input = productionFixture();
  const inputCopy = JSON.parse(JSON.stringify(input));
  const { history, changes, dropped } = await repairEodHistory({ history: input, getTimelineForDate, todayIso: "2026-11-16" });
  assert.deepEqual(input, inputCopy, "input not mutated");
  assert.deepEqual(dropped.sort(), ["2026-11-07", "2026-11-15"]);
  const by = Object.fromEntries(history.map(r => [r.isoDate, r]));
  assert.equal(by["2026-11-07"], undefined);
  assert.equal(by["2026-11-15"], undefined);

  const r11 = by["2026-11-11"];
  assert.equal(r11.outcome, "WIN");
  assert.equal(r11.entrySpot, 25255.05);
  assert.equal(r11.nextDayOpen, 25213.5);
  assert.equal(r11.gapPts, 41.55); // gap −41.55 → STBT win
  assert.deepEqual(r11.resolvedFrom, { date: "2026-11-12", time: "09:15", source: "timeline-open" });
  assert.equal(r11.repaired, true);
  assert.match(r11.notes, /as last recorded that day/);

  const r12 = by["2026-11-12"];
  assert.equal(r12.outcome, "LOSS");
  assert.equal(r12.entrySpot, 25299.35);
  assert.equal(r12.nextDayOpen, 25209.85);
  assert.equal(r12.gapPts, -89.5);
  assert.equal(r12.repaired, true);

  for (const d of ["2026-11-08", "2026-11-09"]) {
    assert.equal(by[d].outcome, "UNRESOLVED", d);
    assert.equal(by[d].repaired, true, d);
    assert.equal(eodUnresolvedLabel(by[d]), "Open not recorded");
  }
  // No timeline for 10-Nov: its entry is left as stored. 13-Nov's entry equals its close.
  assert.equal(by["2026-11-10"].entrySpot, 25044.65);
  assert.equal(by["2026-11-10"].repaired, undefined);
  assert.equal(by["2026-11-13"].repaired, undefined);
  // Today's row is not the repair's business.
  assert.equal(by["2026-11-16"].notes, "Intraday monitoring snapshot.");

  // 06-Nov: the stored, resolved seed-date row is kept and stays a seed row.
  assert.equal(by["2026-11-06"].outcome, "LOSS");
  assert.equal(by["2026-11-06"].source, "seed");
  // Seed rows untouched (apart from the added `source` field).
  for (const s of CANONICAL_EOD_SEED_HISTORY.filter(r => r.isoDate !== "2026-11-06")) {
    assert.deepEqual(by[s.isoDate], s, s.isoDate);
  }
  assert.deepEqual(changes.map(c => c.id).sort(), ["eod_2026-11-08", "eod_2026-11-09", "eod_2026-11-11", "eod_2026-11-12"]);

  // Idempotent.
  const again = await repairEodHistory({ history, getTimelineForDate, todayIso: "2026-11-16" });
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.dropped, []);
  assert.deepEqual(again.history, history);
});

test("repair: NEUTRAL row whose entry differs from that day's close by > 1 pt is corrected; ≤ 1 pt is left", async () => {
  const history = [row("2026-11-10", CASH, "PRESERVED_CASH", 25044.65), row("2026-11-13", CASH, "PRESERVED_CASH", 25144.9)];
  const tls = { "2026-11-10": [tick("09:15", 25000), tick("15:30", 25120.4)], "2026-11-13": TIMELINES["2026-11-13"] };
  const { history: out, changes } = await repairEodHistory({ history, getTimelineForDate: async d => tls[d] || [] });
  const by = Object.fromEntries(out.map(r => [r.isoDate, r]));
  assert.equal(by["2026-11-10"].entrySpot, 25120.4);
  assert.equal(by["2026-11-10"].repaired, true);
  assert.match(by["2026-11-10"].notes, /entry 25120\.4 = that day's closing print \(15:30 tick/);
  assert.match(by["2026-11-10"].notes, /stored entry 25044\.65 was not/);
  assert.equal(by["2026-11-10"].repairVersion, 2);
  assert.equal(by["2026-11-13"].entrySpot, 25144.9, "0.6 pt difference left alone");
  assert.equal(changes.length, 1);
  const again = await repairEodHistory({ history: out, getTimelineForDate: async d => tls[d] || [] });
  assert.deepEqual(again.changes, []);
});

test("repair: carry stored as cash whose entry differs from that day's close gets the close as entry", async () => {
  const history = [row("2026-11-09", CE, "PRESERVED_CASH", 25044.65)];
  const tls = { "2026-11-09": [tick("09:15", 24990), tick("15:30", 25010.2)], "2026-11-10": [tick("09:15", 25060.2)] };
  const { history: out } = await repairEodHistory({ history, getTimelineForDate: async d => tls[d] || [] });
  assert.equal(out[0].entrySpot, 25010.2);
  assert.equal(out[0].outcome, "WIN");
  assert.equal(out[0].gapPts, 50);
});

test("repair once: a throwing timeline reader leaves history unchanged and releases the marker", async () => {
  const history = productionFixture();
  let released = 0;
  const r = await runEodHistoryRepairOnce({
    history,
    claim: async () => true,
    release: async () => { released += 1; },
    getTimelineForDate: async () => { throw new Error("redis down"); },
  });
  assert.equal(r.ran, false);
  assert.equal(r.history, history);
  assert.match(r.error, /redis down/);
  assert.equal(released, 1);
  await assert.rejects(repairEodHistory({ history, getTimelineForDate: async () => { throw new Error("boom"); } }), /boom/);
});

test("repair once: not claimed → no timeline read; claimed → repaired history", async () => {
  let reads = 0;
  const reader = async (d) => { reads += 1; return TIMELINES[d] || []; };
  const skipped = await runEodHistoryRepairOnce({ history: productionFixture(), claim: async () => false, release: async () => {}, getTimelineForDate: reader });
  assert.equal(skipped.ran, false);
  assert.equal(reads, 0);
  const done = await runEodHistoryRepairOnce({ history: productionFixture(), claim: async () => true, release: async () => {}, getTimelineForDate: reader, todayIso: "2026-11-16" });
  assert.equal(done.ran, true);
  assert.equal(done.history.find(r => r.isoDate === "2026-11-11").outcome, "WIN");
  const claimErr = await runEodHistoryRepairOnce({ history: [], claim: async () => { throw new Error("x"); }, release: async () => {}, getTimelineForDate: reader });
  assert.equal(claimErr.ran, false);
  assert.match(claimErr.error, /^claim failed/);
});

// ── Second repair (v2): undo first-repair entries taken from the frozen spot ──

const V1_TAIL = "Verdict as last recorded that day (not known whether it was the 15:38 final).";

// Production state after the first (v1) repair ran with the frozen-tick entry rule.
function productionAfterV1() {
  const pre = productionFixture().filter(r => r.isoDate !== "2026-11-07" && r.isoDate !== "2026-11-15");
  const replace = {
    "2026-11-12": {
      entrySpot: 25275.25, nextDayOpen: 25209.85, gapPts: -65.4, outcome: "LOSS", repaired: true,
      resolvedFrom: { date: "2026-11-13", time: "09:15", source: "timeline-open" },
      notes: `Repaired: entry spot 25299.35 → 25275.25 (that day's close, 15:28 tick); outcome PRESERVED_CASH (kept from an earlier no-carry snapshot) → LOSS from the 2026-11-13 09:15 opening tick. ${V1_TAIL} -65.4 pts morning gap on open`,
    },
    "2026-11-11": {
      entrySpot: 25130, nextDayOpen: 25213.5, gapPts: -83.5, outcome: "LOSS", repaired: true,
      resolvedFrom: { date: "2026-11-12", time: "09:15", source: "timeline-open" },
      notes: `Repaired: entry spot 25255.05 → 25130 (that day's close, 15:25 tick); outcome PRESERVED_CASH (kept from an earlier no-carry snapshot) → LOSS from the 2026-11-12 09:15 opening tick. ${V1_TAIL} -83.5 pts gap-down on open`,
    },
    "2026-11-09": {
      entrySpot: 25003.65, nextDayOpen: null, gapPts: null, outcome: "UNRESOLVED", repaired: true,
      notes: `Repaired: entry spot 25044.65 → 25003.65 (that day's close, 15:29 tick); outcome PRESERVED_CASH (kept from an earlier no-carry snapshot) → UNRESOLVED. ${V1_TAIL} Next session's opening price not available (no recorded timeline for 2026-11-10).`,
    },
    "2026-11-08": {
      nextDayOpen: null, gapPts: null, outcome: "UNRESOLVED", repaired: true,
      notes: `Repaired: outcome PRESERVED_CASH (kept from an earlier no-carry snapshot) → UNRESOLVED. ${V1_TAIL} Next session's opening price not available (no recorded timeline for 2026-11-09).`,
    },
  };
  return pre.map(r => (replace[r.isoDate] ? { ...r, ...replace[r.isoDate] } : r));
}

test("parseV1EntryChange reads the first repair's note", () => {
  assert.deepEqual(parseV1EntryChange("Repaired: entry spot 25299.35 → 25275.25 (that day's close, 15:28 tick); …"), { original: 25299.35, replaced: 25275.25 });
  assert.equal(parseV1EntryChange("Repaired: outcome PRESERVED_CASH → UNRESOLVED."), null);
  assert.equal(parseV1EntryChange("Repaired: entry spot none → 25000 (…)"), null);
});

test("v2 on the production state: 12-Nov LOSS −89.5 at 25299.35, 11-Nov WIN at 25255.05, 09-Nov entry restored and UNRESOLVED, 08-Nov untouched", async () => {
  const input = productionAfterV1();
  const inputCopy = JSON.parse(JSON.stringify(input));
  const reads = [];
  const reader = async (d) => { reads.push(d); return TIMELINES[d] || []; };
  const { history, changes } = await repairEodHistoryV2({ history: input, getTimelineForDate: reader, todayIso: "2026-11-16" });
  assert.deepEqual(input, inputCopy, "input not mutated");
  const by = Object.fromEntries(history.map(r => [r.isoDate, r]));

  const r12 = by["2026-11-12"];
  assert.equal(r12.entrySpot, 25299.35);
  assert.equal(r12.nextDayOpen, 25209.85);
  assert.equal(r12.gapPts, -89.5);
  assert.equal(r12.outcome, "LOSS");
  assert.equal(r12.repairVersion, 2);
  assert.deepEqual(r12.resolvedFrom, { date: "2026-11-13", time: "09:15", source: "timeline-open" });
  assert.match(r12.notes, /entry 25299\.35 = that day's closing print \(15:31 tick/);
  assert.match(r12.notes, /an earlier repair had set 25275\.25/);
  assert.match(r12.notes, /LOSS — next-session open 25209\.85 \(2026-11-13 09:15 tick\), index gap -89\.5 pts = -89\.5 pts for the BTST/);
  assert.match(r12.notes, /Verdict as last recorded that day/);

  const r11 = by["2026-11-11"];
  assert.equal(r11.entrySpot, 25255.05);
  assert.equal(r11.nextDayOpen, 25213.5);
  assert.equal(r11.gapPts, 41.55); // index gap −41.55 → +41.55 for the STBT
  assert.equal(r11.outcome, "WIN");
  assert.match(r11.notes, /index gap -41\.55 pts = \+41\.55 pts for the STBT/);

  const r09 = by["2026-11-09"];
  assert.equal(r09.entrySpot, 25044.65);
  assert.equal(r09.outcome, "UNRESOLVED");
  assert.match(r09.notes, /entry 25044\.65 as originally recorded \(no post-15:30 closing print/);

  const before = Object.fromEntries(sanitizeEodHistory(input).map(r => [r.isoDate, r]));
  for (const d of ["2026-11-08", "2026-11-10", "2026-11-13", "2026-11-16", "2026-11-06"]) {
    assert.deepEqual(by[d], before[d], d);
  }
  assert.deepEqual(changes.map(c => c.id).sort(), ["eod_2026-11-09", "eod_2026-11-11", "eod_2026-11-12"]);
  // Re-scored from the stored nextDayOpen: only the rows' own dates were read.
  assert.deepEqual([...new Set(reads)].sort(), ["2026-11-09", "2026-11-11", "2026-11-12"]);

  const again = await repairEodHistoryV2({ history, getTimelineForDate: reader, todayIso: "2026-11-16" });
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.history, history);
});

test("v2: an unparsable note leaves the row alone; a throwing reader leaves history unchanged and releases the marker", async () => {
  const odd = { ...row("2026-11-12", CE, "LOSS", 25275.25, { nextDayOpen: 25209.85, gapPts: -65.4 }), repaired: true, notes: "Repaired by hand: entry changed" };
  const { history, changes } = await repairEodHistoryV2({ history: [odd], getTimelineForDate: getTimelineForDate });
  assert.deepEqual(changes, []);
  assert.equal(history[0].entrySpot, 25275.25);
  assert.equal(history[0].repairVersion, undefined);

  const input = productionAfterV1();
  let released = 0;
  const r = await runEodHistoryRepairOnce({
    history: input,
    claim: async () => true,
    release: async () => { released += 1; },
    getTimelineForDate: async () => { throw new Error("redis down"); },
    repair: repairEodHistoryV2,
  });
  assert.equal(r.ran, false);
  assert.equal(r.history, input);
  assert.equal(released, 1);
});

test("fresh database (rows as before v1): current repair then v2 ends in the same correct state; v2 changes nothing", async () => {
  const first = await repairEodHistory({ history: productionFixture(), getTimelineForDate, todayIso: "2026-11-16" });
  const second = await repairEodHistoryV2({ history: first.history, getTimelineForDate, todayIso: "2026-11-16" });
  assert.deepEqual(second.changes, []);
  const fresh = Object.fromEntries(second.history.map(r => [r.isoDate, r]));
  const prod = Object.fromEntries((await repairEodHistoryV2({ history: productionAfterV1(), getTimelineForDate, todayIso: "2026-11-16" })).history.map(r => [r.isoDate, r]));
  const pick = r => ({ entrySpot: r.entrySpot, nextDayOpen: r.nextDayOpen, gapPts: r.gapPts, outcome: r.outcome });
  assert.deepEqual(pick(fresh["2026-11-12"]), { entrySpot: 25299.35, nextDayOpen: 25209.85, gapPts: -89.5, outcome: "LOSS" });
  assert.deepEqual(pick(fresh["2026-11-11"]), { entrySpot: 25255.05, nextDayOpen: 25213.5, gapPts: 41.55, outcome: "WIN" });
  assert.deepEqual(pick(fresh["2026-11-09"]), { entrySpot: 25044.65, nextDayOpen: null, gapPts: null, outcome: "UNRESOLVED" });
  assert.deepEqual(pick(fresh["2026-11-08"]), { entrySpot: 24986.4, nextDayOpen: null, gapPts: null, outcome: "UNRESOLVED" });
  for (const d of ["2026-11-12", "2026-11-11", "2026-11-09", "2026-11-08"]) {
    assert.deepEqual(pick(fresh[d]), pick(prod[d]), d);
    assert.equal(fresh[d].repairVersion, 2, d);
  }
});

// ── Statistics ───────────────────────────────────────────────────────────────

test("stats: recorded-live vs hand-entered tallies; IN_PROGRESS / UNRESOLVED excluded; too few to judge", async () => {
  const { history } = await repairEodHistory({ history: productionFixture(), getTimelineForDate, todayIso: "2026-11-16" });
  const today = reconcileEodHistory({ history, todayIso: "2026-11-16", nowMins: 700, timeStr: "11:40 IST", dayName: "Monday", spot: 25283.9, eodDecision: NEUTRAL, todayTimeline: [tick("09:15", 25200)] });
  const { live, seed } = computeEodTrackStats(today);
  // Recorded live: 13 cash, 12 LOSS, 11 WIN, 10 cash, 09/08 UNRESOLVED, 16 in progress.
  assert.equal(live.wins, 1);
  assert.equal(live.losses, 1);
  assert.equal(live.resolved, 2);
  assert.equal(live.winRatePct, 50);
  assert.equal(live.tooFew, true);
  assert.equal(live.cashDays, 2);
  assert.equal(live.unresolved, 2);
  assert.equal(live.inProgress, 1);
  assert.equal(live.sessions, 6);
  assert.equal(live.netPts, round(41.55 - 89.5));
  assert.equal(formatEodWinRate(live), "1/2 (50.0%) — too few to judge");
  // Hand-entered: 11 carries (10 WIN + the 06-Nov LOSS), 6 cash days.
  assert.equal(seed.wins, 10);
  assert.equal(seed.losses, 1);
  assert.equal(seed.cashDays, 6);
  assert.equal(seed.sessions, 17);
  assert.ok(today.filter(isSeedRow).length === 17);
});

test("stats: carry rows still stored as cash count neither as a result nor as a cash day; 10+ resolved is judged", () => {
  const rows = [
    row("2026-11-12", CE, "PRESERVED_CASH", 1),
    { ...row("2026-11-16", CE, "IN_PROGRESS", 1), provisional: true },
    row("2026-11-11", PE, "UNRESOLVED", 1),
  ];
  const s = computeEodTrackStats(rows).live;
  assert.equal(s.cashDays, 0);
  assert.equal(s.resolved, 0);
  assert.equal(s.carryStoredAsCash, 1);
  assert.equal(formatEodWinRate(s), "no resolved carries yet — too few to judge");
  const many = [];
  for (let d = 1; d <= 16; d++) {
    const iso = `2026-12-${String(d).padStart(2, "0")}`;
    if (!isSessionDate(iso)) continue;
    many.push(row(iso, CE, d % 3 === 0 ? "LOSS" : "WIN", 1, { gapPts: d % 3 === 0 ? -10 : 10 }));
  }
  const m = computeEodTrackStats(many).live;
  assert.equal(m.resolved, 12);
  assert.equal(m.tooFew, false);
  assert.match(formatEodWinRate(m), /^\d+\/12 \(\d+\.\d%\)$/);
});

function round(x) {
  return Number(x.toFixed(2));
}

test("sanitizeEodHistory sets source: seed for seed dates and recorded otherwise", () => {
  const out = sanitizeEodHistory([row("2026-11-04", CE, "WIN", 1), row("2026-11-12", CE, "WIN", 1), { ...row("2026-11-05", CASH, "PRESERVED_CASH", 1), source: "recorded" }]);
  const by = Object.fromEntries(out.map(r => [r.isoDate, r.source]));
  assert.deepEqual(by, { "2026-11-04": "seed", "2026-11-12": "recorded", "2026-11-05": "recorded" });
  assert.ok(CANONICAL_EOD_SEED_HISTORY.every(r => r.source === "seed"));
  assert.equal(CANONICAL_EOD_SEED_HISTORY.length, 17);
});
