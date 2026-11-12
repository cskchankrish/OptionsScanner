/**
 * Data-quality (tick coverage) for the per-minute scanner timeline.
 *
 * The scanner aims for one tick per minute (poller). Anything that reads MORE than the latest
 * tick (30-min radar, closing-hour flow, last-hour delta, rolling futures quadrant, floor/roof
 * migration, the intraday reversal detector) must check the coverage of ITS OWN window first and,
 * when it is insufficient, say "not enough data for <window> (n of m expected ticks; gap
 * hh:mm–hh:mm)" instead of concluding.
 *
 * Pure functions only (no I/O, no Date.now()): safe for the browser bundle and for tests.
 * Minutes are IST minutes since midnight (555 = 09:15).
 */

// ── Thresholds ──────────────────────────────────────────────────────────────
// Gaps of this many minutes or more between consecutive ticks are LISTED (and make the session
// state GAPS). 3 minutes = two consecutive missed one-minute ticks: a single missed tick is normal
// jitter of an every-minute scheduler, two in a row is not.
export const DQ_GAP_LIST_MIN = 3;
// A gap of this many minutes or more triggers the one-time Telegram "scanner missed ticks" alert
// (per gap). 5 minutes = a third of a 15-minute candle: enough to distort candle-based readings.
export const DQ_GAP_ALERT_MIN = 5;
// A WINDOW is covered when its largest hole (including the edges of the window) is at most this
// many minutes AND it has at least DQ_WINDOW_MIN_COVERAGE_PCT of its expected ticks. 4 minutes
// tolerates up to three consecutive missed ticks; the 12-Nov afternoon (1–5 browser ticks per
// 15 minutes, holes of 5–15 minutes) fails it, a working every-minute poller passes it.
export const DQ_WINDOW_MAX_GAP_MIN = 4;
export const DQ_WINDOW_MIN_COVERAGE_PCT = 70;
// The session is BUILDING until it has this many minutes and ticks since the open.
export const DQ_BUILDING_MIN_MINUTES = 10;
export const DQ_BUILDING_MIN_TICKS = 5;
// The latest snapshot is STALE (live session) when older than this; same default as the
// scanner-blind watchdog (FLOW_BLIND_ALERT_SEC).
export const DQ_STALE_AFTER_SEC = 180;

export const SESSION = {
  weekday: { open: 555, close: 940 }, // 09:15–15:40 IST (F&O close)
  sunday: { open: 840, close: 960 }, // Diwali Muhurat 14:00–16:00 IST
};

export function hhmm(m) {
  const v = Math.round(Number(m));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/** Distinct, sorted tick minutes inside [start, end]. */
export function tickMinutes(timeline, start, end) {
  const set = new Set();
  for (const pt of Array.isArray(timeline) ? timeline : []) {
    const m = Number(pt?.minutes);
    if (!Number.isFinite(m) || m < start || m > end) continue;
    if (pt.synthetic === true) continue; // placeholder ticks are not data
    if (pt.netDiff === undefined && pt.futPrice === undefined && pt.spot === undefined) continue;
    set.add(Math.round(m));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Coverage of one window [startMins, endMins] (inclusive minutes).
 * @returns {{ ok, label, start, end, observed, expected, coveragePct, maxGapMin, worstGap, text }}
 *   worstGap = { from, to, minutes } (hh:mm strings), text = human sentence when not ok.
 */
export function windowCoverage(timeline, startMins, endMins, {
  label = "window",
  maxGapMin = DQ_WINDOW_MAX_GAP_MIN,
  minCoveragePct = DQ_WINDOW_MIN_COVERAGE_PCT,
} = {}) {
  const start = Math.round(Number(startMins));
  const end = Math.round(Number(endMins));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { ok: false, label, start, end, observed: 0, expected: 0, coveragePct: 0, maxGapMin: null, worstGap: null, text: `not enough data for ${label} (invalid window)` };
  }
  const mins = tickMinutes(timeline, start, end);
  const expected = end - start + 1;
  const observed = mins.length;
  const coveragePct = Math.round((observed / expected) * 100);
  // Holes including the window edges: start→first, between ticks, last→end.
  const points = [start - 1, ...mins, end + 1]; // sentinels so an edge hole counts its missing minutes
  let worst = { from: start, to: end, minutes: 0 };
  for (let i = 1; i < points.length; i++) {
    const missing = points[i] - points[i - 1] - 1; // minutes with no tick
    const hole = missing + 1; // time between the surrounding readings, as in the gap list
    if (missing > 0 && hole > worst.minutes) {
      worst = { from: Math.max(start, points[i - 1]), to: Math.min(end, points[i]), minutes: hole };
    }
  }
  const maxGap = worst.minutes;
  const ok = observed > 0 && maxGap <= maxGapMin && coveragePct >= minCoveragePct;
  const worstGap = maxGap > 0 ? { from: hhmm(worst.from), to: hhmm(worst.to), minutes: maxGap } : null;
  const text = ok
    ? null
    : `not enough data for ${label} (${observed} of ${expected} expected ticks${worstGap ? `; gap ${worstGap.from}–${worstGap.to}` : ""})`;
  return { ok, label, start: hhmm(start), end: hhmm(end), observed, expected, coveragePct, maxGapMin: maxGap, worstGap, text };
}

/**
 * Session-level data quality.
 * @param {object} p
 * @param {Array} p.timeline       per-minute ticks ({ minutes, ... })
 * @param {number} p.nowMins       IST minutes now
 * @param {boolean} [p.isSunday]
 * @param {boolean} [p.isLive]     live session (affects STALE)
 * @param {number|null} [p.snapshotAgeSec]
 * @returns {{ state: "OK"|"GAPS"|"STALE"|"BUILDING", sessionStart, evaluatedTo, ticksToday, expectedTicks,
 *   coveragePct, gaps, maxGapMin, lastTickTime, snapshotAgeSec, windows, thresholds, summary }}
 */
export function computeDataQuality({ timeline = [], nowMins, isSunday = false, isLive = true, snapshotAgeSec = null, staleAfterSec = DQ_STALE_AFTER_SEC } = {}) {
  const { open, close } = isSunday ? SESSION.sunday : SESSION.weekday;
  const now = Math.round(Number(nowMins));
  const end = Math.min(Number.isFinite(now) ? now : close, close);
  const thresholds = {
    gapListMin: DQ_GAP_LIST_MIN, gapAlertMin: DQ_GAP_ALERT_MIN, windowMaxGapMin: DQ_WINDOW_MAX_GAP_MIN,
    windowMinCoveragePct: DQ_WINDOW_MIN_COVERAGE_PCT, staleAfterSec,
  };
  if (end < open) {
    return {
      state: "BUILDING", sessionStart: hhmm(open), evaluatedTo: null, ticksToday: 0, expectedTicks: 0, coveragePct: null,
      gaps: [], maxGapMin: 0, lastTickTime: null, snapshotAgeSec, windows: {}, thresholds,
      summary: `session opens ${hhmm(open)} IST`,
    };
  }
  const mins = tickMinutes(timeline, open, end);
  const expectedTicks = end - open + 1;
  const ticksToday = mins.length;
  const coveragePct = Math.round((ticksToday / expectedTicks) * 100);

  const gaps = [];
  let maxGapMin = 0;
  const pushGap = (fromM, toM, openEnded = false) => {
    const minutes = toM - fromM;
    if (minutes > maxGapMin) maxGapMin = minutes;
    if (minutes >= DQ_GAP_LIST_MIN) gaps.push({ from: hhmm(fromM), to: openEnded ? "now" : hhmm(toM), minutes, fromMins: fromM, toMins: toM, ...(openEnded ? { ongoing: true } : {}) });
  };
  if (mins.length) {
    if (mins[0] - open >= 1) pushGap(open, mins[0]);
    for (let i = 1; i < mins.length; i++) pushGap(mins[i - 1], mins[i]);
    if (end - mins[mins.length - 1] >= 1) pushGap(mins[mins.length - 1], end, isLive && now <= close);
  } else {
    pushGap(open, end, isLive && now <= close);
  }

  const lastTickTime = mins.length ? hhmm(mins[mins.length - 1]) : null;
  const windows = {
    last30: windowCoverage(timeline, Math.max(open, end - 29), end, { label: `the last 30 minutes (${hhmm(Math.max(open, end - 29))}–${hhmm(end)})` }),
    lastHour: windowCoverage(timeline, Math.max(open, end - 59), end, { label: `the last hour (${hhmm(Math.max(open, end - 59))}–${hhmm(end)})` }),
  };

  let state;
  if (isLive && snapshotAgeSec !== null && Number.isFinite(snapshotAgeSec) && snapshotAgeSec > staleAfterSec) state = "STALE";
  else if (end - open < DQ_BUILDING_MIN_MINUTES || ticksToday < DQ_BUILDING_MIN_TICKS) state = "BUILDING";
  else if (gaps.length > 0) state = "GAPS";
  else state = "OK";

  const summary = state === "OK"
    ? `complete since ${hhmm(open)} (${ticksToday}/${expectedTicks} ticks)`
    : state === "STALE"
    ? `stale: latest snapshot ${Math.round(snapshotAgeSec)}s old`
    : state === "BUILDING"
    ? `building: ${ticksToday} tick(s) since ${hhmm(open)}`
    : `${gaps.length} gap(s) since ${hhmm(open)}: ${gaps.map((g) => `${g.from}–${g.to}`).join(", ")} (${coveragePct}% coverage)`;

  return {
    state, sessionStart: hhmm(open), evaluatedTo: hhmm(end), ticksToday, expectedTicks, coveragePct,
    gaps: gaps.map(({ fromMins, toMins, ...g }) => g), maxGapMin, lastTickTime, snapshotAgeSec, windows, thresholds, summary,
    _gapMins: gaps.map((g) => ({ fromMins: g.fromMins, toMins: g.toMins, minutes: g.minutes, ongoing: Boolean(g.ongoing) })),
  };
}

/**
 * Merges two timelines by minute (union). For the same minute the `preferred` tick wins.
 * Used so concurrent writers (poller, browser, webhook function instances) never drop each
 * other's ticks.
 */
export function mergeTimelines(preferred = [], other = []) {
  const byMin = new Map();
  for (const pt of Array.isArray(other) ? other : []) {
    if (pt && Number.isFinite(Number(pt.minutes))) byMin.set(Number(pt.minutes), pt);
  }
  for (const pt of Array.isArray(preferred) ? preferred : []) {
    if (pt && Number.isFinite(Number(pt.minutes))) byMin.set(Number(pt.minutes), pt);
  }
  return [...byMin.values()].sort((a, b) => a.minutes - b.minutes);
}
