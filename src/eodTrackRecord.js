/**
 * EOD Overnight Carry Track Record & History Manager
 * Provides deterministic date normalization, deduplication, chronological sorting,
 * row lifecycle (IN_PROGRESS → final → resolved), the one-off repair of stored rows and the
 * track-record statistics. DISPLAY / HISTORY ONLY: nothing here feeds a trading decision.
 * Pure module (no I/O); the server (api/nifty-oi.js) and the client (src/NiftyFlowView.jsx)
 * both call it, and the timeline reader for the repair is injected.
 */
import { getSessionKindForDate, nextIsoDate } from "./marketCalendar.js";

export function normalizeDateToIso(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return "";
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // DD-MMM-YYYY (e.g. 05-Nov-2026, 4-Nov-2026)
  const dmmmy = trimmed.match(/^(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4})$/i);
  if (dmmmy) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const day = dmmmy[1].padStart(2, "0");
    const month = months[dmmmy[2].toLowerCase()];
    const year = dmmmy[3];
    return `${year}-${month}-${day}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY (e.g. 05-11-2026, 4/11/2026)
  const dmy = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    const year = dmy[3];
    return `${year}-${month}-${day}`;
  }

  // eod_YYYY-MM-DD
  const eodIso = trimmed.match(/^eod_(\d{4}-\d{2}-\d{2})$/);
  if (eodIso) return eodIso[1];

  // eod_DD-MM-YYYY or eod_DD/MM/YYYY
  const eodDmy = trimmed.match(/^eod_(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (eodDmy) {
    return `${eodDmy[3]}-${eodDmy[2].padStart(2, "0")}-${eodDmy[1].padStart(2, "0")}`;
  }

  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    try {
      return parsed.toISOString().slice(0, 10);
    } catch (_) {}
  }
  return trimmed;
}

export function formatIsoToDisplayDate(isoStr) {
  if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return isoStr;
  const [y, m, d] = isoStr.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mIdx = parseInt(m, 10) - 1;
  return `${d}-${monthNames[mIdx] || m}-${y}`;
}

// Hand-entered history: these 17 rows were typed into this file (real index prices, verdicts
// written afterwards). They are NOT output of the running system and are reported separately
// ("Hand-entered (before 7 Nov 2026)"). Each exported row carries `source: "seed"`.
const RAW_EOD_SEED_HISTORY = [
  {
    id: "eod_2026-11-06",
    isoDate: "2026-11-06",
    date: "06-Nov-2026",
    dayName: "Friday",
    time: "15:40 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 3,
    conviction: 84,
    sizing: "50% Size (Weekend Risk Control)",
    entrySpot: 25030.35,
    nextDayOpen: null,
    gapPts: null,
    outcome: "PENDING",
    floor: 25000,
    roof: 25200,
    pcr: 1.66,
    deltaPcr: 1.58,
    pcrWarning: "🚨 HISTORICAL PEAK OVERBOUGHT (PCR 1.66 ≥ 1.65 — 5-Yr Extreme Exhaustion)",
    action: "Favorable for holding overnight Nifty CE at 50% half size. Smart money defended 25,000 floor. Target: Continuation toward 25,200. Strict SL: 24,950. Tighten risk due to PCR 1.66 historical overbought crowding.",
    keyReasons: "Put writing dominant (+2) · Closing hour flow +1.0L lots (+3) · PCR 1.66 Overbought Penalty (-1) · Friday 50% Size limit",
    notes: "Carried overnight at 50% half size due to Friday 48h weekend decay rule and PCR 1.66 overbought caution.",
  },
  {
    id: "eod_2026-11-05",
    isoDate: "2026-11-05",
    date: "05-Nov-2026",
    dayName: "Thursday",
    time: "15:20 IST",
    verdict: "EXIT TO CASH / DO NOT CARRY",
    bias: "NEUTRAL",
    score: 1,
    conviction: 82,
    sizing: "0% (Cash Only)",
    entrySpot: 24536.60,
    nextDayOpen: 24538.20,
    gapPts: 1.60,
    outcome: "PRESERVED_CASH",
    floor: 24400,
    roof: 24650,
    pcr: 1.34,
    deltaPcr: 0.85,
    pcrWarning: "⚠️ LATE CALL BLITZ VETO: >1.2L CE written after 14:15",
    action: "Late institutional Call blitz (+1.2L CE) neutralized morning bounce. Score +1 below BTST threshold (+3). Preserved 100% capital in cash.",
    keyReasons: "Late Call Blitz (-3) · Heavy CE Writing >1.2L · Avoided overnight gap trap and morning dip to 24,388",
    notes: "Avoided early morning drop to 24,388.05 low (-148 pts drop from open). 100% capital preserved in cash.",
  },
  {
    id: "eod_2026-11-04",
    isoDate: "2026-11-04",
    date: "04-Nov-2026",
    dayName: "Wednesday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 4,
    conviction: 89,
    sizing: "75% Normal Size",
    entrySpot: 23960.60,
    nextDayOpen: 24378.05,
    gapPts: 417.45,
    outcome: "WIN",
    floor: 23800,
    roof: 24200,
    pcr: 1.26,
    deltaPcr: 1.68,
    pcrWarning: null,
    action: "Strong put writing support established at 23,800. Favorable BTST setup.",
    keyReasons: "Put writing dominant (+2) · Closing hour flow +34k lots (+2) · Bullish PCR 1.26 (+1)",
    notes: "Massive gap-up +417.45 pts at 09:15 open (23,960.60 -> 24,378.05). All targets hit on open bell.",
  },
  {
    id: "eod_2026-11-03",
    isoDate: "2026-11-03",
    date: "03-Nov-2026",
    dayName: "Tuesday",
    time: "15:20 IST",
    verdict: "EXIT TO CASH / DO NOT CARRY",
    bias: "NEUTRAL",
    score: 0,
    conviction: 80,
    sizing: "0% (Cash Only)",
    entrySpot: 23810.85,
    nextDayOpen: 23742.25,
    gapPts: -68.60,
    outcome: "PRESERVED_CASH",
    floor: 23700,
    roof: 23950,
    pcr: 0.98,
    deltaPcr: 1.02,
    pcrWarning: null,
    action: "Balanced intraday writing without clear edge. Preserved capital in cash.",
    keyReasons: "Balanced writing (0 pts) · Flat closing delta (0 pts) · Neutral PCR 0.98 (0 pts)",
    notes: "Avoided -68.60 pts morning gap-down trap (23,810.85 -> 23,742.25). 100% capital preserved.",
  },
  {
    id: "eod_2026-11-02",
    isoDate: "2026-11-02",
    date: "02-Nov-2026",
    dayName: "Monday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 3,
    conviction: 84,
    sizing: "75% Normal Size",
    entrySpot: 23440.80,
    nextDayOpen: 23582.25,
    gapPts: 141.45,
    outcome: "WIN",
    floor: 23300,
    roof: 23600,
    pcr: 1.21,
    deltaPcr: 1.52,
    pcrWarning: null,
    action: "Heavy put accumulation at 23,300-23,400. Carried overnight CE.",
    keyReasons: "Put underwriting (+2) · Closing hour delta +26k lots (+2) · PCR 1.21 (+1)",
    notes: "Gap-up +141.45 pts captured at Tuesday open (23,440.80 -> 23,582.25). Target booked.",
  },
  {
    id: "eod_2026-10-30",
    isoDate: "2026-10-30",
    date: "30-Oct-2026",
    dayName: "Friday",
    time: "15:20 IST",
    verdict: "EXIT TO CASH / DO NOT CARRY",
    bias: "NEUTRAL",
    score: 2,
    conviction: 80,
    sizing: "0% (Cash Only)",
    entrySpot: 23053.10,
    nextDayOpen: 23222.30,
    gapPts: 169.20,
    outcome: "PRESERVED_CASH",
    floor: 22900,
    roof: 23200,
    pcr: 1.15,
    deltaPcr: 1.30,
    pcrWarning: null,
    action: "Friday Risk Rule enforced: Score +2 below Friday safety threshold (+4). Preserved 100% cash.",
    keyReasons: "Friday Risk Rule: Score +2 below +4 weekend carry threshold · 48h theta decay protection",
    notes: "Disciplined risk control: preserved 100% cash through 48h weekend theta decay.",
  },
  {
    id: "eod_2026-10-29",
    isoDate: "2026-10-29",
    date: "29-Oct-2026",
    dayName: "Thursday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 3,
    conviction: 82,
    sizing: "75% Normal Size",
    entrySpot: 22936.75,
    nextDayOpen: 22964.50,
    gapPts: 27.75,
    outcome: "WIN",
    floor: 22800,
    roof: 23100,
    pcr: 1.18,
    deltaPcr: 1.46,
    pcrWarning: null,
    action: "Put writing dominant on monthly expiry rollover. Favorable for BTST CE.",
    keyReasons: "Put writing (+2) · Closing delta +18k lots (+1) · PCR 1.18 (+1)",
    notes: "Gap up +27.75 pts at morning bell (22,936.75 -> 22,964.50).",
  },
  {
    id: "eod_2026-10-28",
    isoDate: "2026-10-28",
    date: "28-Oct-2026",
    dayName: "Wednesday",
    time: "15:20 IST",
    verdict: "EXIT TO CASH / DO NOT CARRY",
    bias: "NEUTRAL",
    score: 0,
    conviction: 79,
    sizing: "0% (Cash Only)",
    entrySpot: 22698.85,
    nextDayOpen: 22690.65,
    gapPts: -8.20,
    outcome: "PRESERVED_CASH",
    floor: 22550,
    roof: 22800,
    pcr: 1.01,
    deltaPcr: 0.98,
    pcrWarning: null,
    action: "Range-bound straddle flow. No overnight edge.",
    keyReasons: "Balanced flow (0 pts) · Neutral delta (0 pts) · Straddle pinning near ATM",
    notes: "Avoided flat open chop (-8.20 pts). Cash preserved.",
  },
  {
    id: "eod_2026-10-27",
    isoDate: "2026-10-27",
    date: "27-Oct-2026",
    dayName: "Tuesday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY PE (STBT)",
    bias: "BEARISH",
    score: -3,
    conviction: 85,
    sizing: "75% Normal Size",
    entrySpot: 22749.75,
    nextDayOpen: 22678.00,
    gapPts: 71.75,
    outcome: "WIN",
    floor: 22600,
    roof: 22850,
    pcr: 0.81,
    deltaPcr: 0.65,
    pcrWarning: null,
    action: "Heavy Call capping at 22,800. Favorable for overnight Put carry.",
    keyReasons: "Call writing dominant (-2) · Negative closing delta (-1) · PCR 0.81 (-1)",
    notes: "STBT captured +71.75 pts morning gap-down (22,749.75 -> 22,678.00). Put options expanded.",
  },
  {
    id: "eod_2026-10-26",
    isoDate: "2026-10-26",
    date: "26-Oct-2026",
    dayName: "Monday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY PE (STBT)",
    bias: "BEARISH",
    score: -3,
    conviction: 83,
    sizing: "75% Normal Size",
    entrySpot: 22753.20,
    nextDayOpen: 22708.80,
    gapPts: 44.40,
    outcome: "WIN",
    floor: 22600,
    roof: 22800,
    pcr: 0.84,
    deltaPcr: 0.72,
    pcrWarning: null,
    action: "Institutional supply wall built above 22,800. STBT carry executed.",
    keyReasons: "Call distribution (-2) · Negative closing flow (-1) · PCR 0.84 (-1)",
    notes: "Overnight Put captured +44.40 pts gap-down slippage (22,753.20 -> 22,708.80).",
  },
  {
    id: "eod_2026-10-23",
    isoDate: "2026-10-23",
    date: "23-Oct-2026",
    dayName: "Friday",
    time: "15:20 IST",
    verdict: "EXIT TO CASH / DO NOT CARRY",
    bias: "NEUTRAL",
    score: 1,
    conviction: 78,
    sizing: "0% (Cash Only)",
    entrySpot: 22600.00,
    nextDayOpen: 22524.40,
    gapPts: -75.60,
    outcome: "PRESERVED_CASH",
    floor: 22500,
    roof: 22750,
    pcr: 0.95,
    deltaPcr: 1.10,
    pcrWarning: null,
    action: "Friday theta decay rule enforced: score below +4 threshold. Preserved capital in cash.",
    keyReasons: "Friday Risk Rule: Score +1 below +4 weekend carry threshold · Avoided 48h theta bleed",
    notes: "Saved from weekend theta bleed and -75.60 pts Monday morning gap-down (22,600.00 -> 22,524.40).",
  },
  {
    id: "eod_2026-10-22",
    isoDate: "2026-10-22",
    date: "22-Oct-2026",
    dayName: "Thursday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 3,
    conviction: 83,
    sizing: "75% Normal Size",
    entrySpot: 22687.65,
    nextDayOpen: 22742.20,
    gapPts: 54.55,
    outcome: "WIN",
    floor: 22550,
    roof: 22800,
    pcr: 1.20,
    deltaPcr: 1.48,
    pcrWarning: null,
    action: "Floor defense confirmed at 22,550. Favorable BTST setup.",
    keyReasons: "Put writing (+2) · Positive delta (+1) · Bullish PCR 1.20 (+1)",
    notes: "Gap-up +54.55 pts captured at Friday morning open (22,687.65 -> 22,742.20).",
  },
  {
    id: "eod_2026-10-21",
    isoDate: "2026-10-21",
    date: "21-Oct-2026",
    dayName: "Wednesday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY PE (STBT)",
    bias: "BEARISH",
    score: -4,
    conviction: 88,
    sizing: "75% Normal Size",
    entrySpot: 22811.35,
    nextDayOpen: 22687.75,
    gapPts: 123.60,
    outcome: "WIN",
    floor: 22650,
    roof: 22950,
    pcr: 0.77,
    deltaPcr: 0.52,
    pcrWarning: null,
    action: "Heavy call writing acceleration into close. Carried overnight PE.",
    keyReasons: "Call writing dominant (-2) · Late negative Delta acceleration (-2) · PCR 0.77 (-1)",
    notes: "STBT captured +123.60 pts morning gap-down (22,811.35 -> 22,687.75). Large profit booked.",
  },
  {
    id: "eod_2026-10-19",
    isoDate: "2026-10-19",
    date: "19-Oct-2026",
    dayName: "Monday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 4,
    conviction: 87,
    sizing: "75% Normal Size",
    entrySpot: 22888.95,
    nextDayOpen: 23016.00,
    gapPts: 127.05,
    outcome: "WIN",
    floor: 22750,
    roof: 23050,
    pcr: 1.27,
    deltaPcr: 1.64,
    pcrWarning: null,
    action: "Institutional put underwriting floor at 22,750. High conviction BTST.",
    keyReasons: "Put writing (+2) · Closing accumulation (+2) · PCR expansion (+1)",
    notes: "Gap-up +127.05 pts captured on open (22,888.95 -> 23,016.00). Target booked.",
  },
  {
    id: "eod_2026-10-16",
    isoDate: "2026-10-16",
    date: "16-Oct-2026",
    dayName: "Friday",
    time: "15:20 IST",
    verdict: "EXIT TO CASH / DO NOT CARRY",
    bias: "NEUTRAL",
    score: 2,
    conviction: 80,
    sizing: "0% (Cash Only)",
    entrySpot: 23146.15,
    nextDayOpen: 23150.85,
    gapPts: 4.70,
    outcome: "PRESERVED_CASH",
    floor: 23000,
    roof: 23250,
    pcr: 1.14,
    deltaPcr: 1.28,
    pcrWarning: null,
    action: "Friday safety threshold enforced: score below +4. Preserved 100% cash.",
    keyReasons: "Friday Rule: Avoided 48h weekend theta decay without 80%+ directional dominance",
    notes: "Preserved 100% cash through weekend.",
  },
  {
    id: "eod_2026-10-15",
    isoDate: "2026-10-15",
    date: "15-Oct-2026",
    dayName: "Thursday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 3,
    conviction: 83,
    sizing: "75% Normal Size",
    entrySpot: 22997.35,
    nextDayOpen: 23065.10,
    gapPts: 67.75,
    outcome: "WIN",
    floor: 22850,
    roof: 23100,
    pcr: 1.23,
    deltaPcr: 1.55,
    pcrWarning: null,
    action: "Support established near 22,850. Favorable for overnight CE.",
    keyReasons: "Put underwriting (+2) · Closing positive flow (+1) · PCR 1.23 (+1)",
    notes: "Gap-up +67.75 pts captured on Friday open (22,997.35 -> 23,065.10).",
  },
  {
    id: "eod_2026-10-14",
    isoDate: "2026-10-14",
    date: "14-Oct-2026",
    dayName: "Wednesday",
    time: "15:20 IST",
    verdict: "CARRY NIFTY CE (BTST)",
    bias: "BULLISH",
    score: 3,
    conviction: 82,
    sizing: "75% Normal Size",
    entrySpot: 22622.70,
    nextDayOpen: 22671.30,
    gapPts: 48.60,
    outcome: "WIN",
    floor: 22500,
    roof: 22750,
    pcr: 1.19,
    deltaPcr: 1.42,
    pcrWarning: null,
    action: "Steady put writing above 22,500. Carried overnight CE.",
    keyReasons: "Put writing (+2) · Moderate closing delta (+1) · PCR 1.19 (+1)",
    notes: "Gap-up +48.60 pts captured on open (22,622.70 -> 22,671.30).",
  },
];

/** The hand-entered rows, each marked `source: "seed"` (frozen: seed rows are never modified). */
export const CANONICAL_EOD_SEED_HISTORY = Object.freeze(
  RAW_EOD_SEED_HISTORY.map(row => Object.freeze({ ...row, source: "seed" }))
);

const SEED_DATE_SET = new Set(RAW_EOD_SEED_HISTORY.map(row => row.isoDate));

/** First date recorded by the running system (rows before it are hand-entered seed rows). */
export const EOD_RECORDED_FROM_ISO = "2026-11-07";

export const EOD_OUTCOMES = Object.freeze({
  WIN: "WIN",
  LOSS: "LOSS",
  PENDING: "PENDING",
  PRESERVED_CASH: "PRESERVED_CASH",
  IN_PROGRESS: "IN_PROGRESS", // today's row before the verdict is final
  UNRESOLVED: "UNRESOLVED", // the next session's opening price is not available (or the verdict never became final)
});

const RESOLVED_OUTCOMES = new Set(["WIN", "LOSS"]);
const OPEN_OUTCOMES = new Set(["PENDING", "UNRESOLVED"]);

export const EOD_IN_PROGRESS_NOTE = "session in progress — verdict not final";
export const EOD_OPEN_NOT_AVAILABLE_NOTE = "next session's opening price not available";
export const EOD_VERDICT_NOT_FINAL_PREFIX = "Verdict never finalised";

/**
 * Finalisation: the stored verdict becomes final at the first refresh at or after 15:38 IST on a
 * weekday (2 minutes before the 15:40 close; 15:58 on the Muhurat date, close 16:00). 15:38 is
 * EOD_WINDOW_END_MINS (end of the radar / flip alerts) and the minute the carry bridge reports,
 * after its 15:31–15:37 order window, and the scorecard's FINAL EOD reading is the last one at or
 * before 15:38 — so the verdict stored at that point is the one a trader (or the bridge) acted on.
 * (The older condition, `isDecisionWindow || nowMins >= closeMins`, is true from 14:45, while the
 * verdict can still flip until 15:38.)
 */
export const EOD_FINAL_MINS_WEEKDAY = 938;
export const EOD_FINAL_MINS_MUHURAT = 958;
/** The first tick of the next session counts as its open only if recorded within this many minutes of the session open. */
export const EOD_OPEN_TICK_MAX_DELAY_MINS = 15;
/** Fewer resolved carries than this → "too few to judge". */
export const EOD_TOO_FEW_RESOLVED = 10;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function hhmmOf(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function round2(x) {
  const v = Number(Number(x).toFixed(2));
  return v === 0 ? 0 : v; // no -0
}

/** True for a trading session date: Mon–Fri and Muhurat dates; false for a closed weekend date or a malformed date. */
export function isSessionDate(isoDate) {
  const iso = normalizeDateToIso(isoDate);
  return ISO_RE.test(iso) && getSessionKindForDate(iso) !== "CLOSED";
}

/** Open / close / finalisation minutes (IST) of a session date; nulls for a closed date. */
export function eodSessionTimes(isoDate) {
  const kind = getSessionKindForDate(isoDate);
  if (kind === "MUHURAT") return { kind, openMins: 840, closeMins: 960, finalMins: EOD_FINAL_MINS_MUHURAT, closeTimeStr: "16:00" };
  if (kind === "WEEKDAY") return { kind, openMins: 555, closeMins: 940, finalMins: EOD_FINAL_MINS_WEEKDAY, closeTimeStr: "15:40" };
  return { kind, openMins: null, closeMins: null, finalMins: null, closeTimeStr: null };
}

/** The next session date after isoDate by the calendar (closed weekend days skipped; exchange holidays are not modelled). */
export function nextSessionDate(isoDate) {
  if (!ISO_RE.test(String(isoDate || ""))) return null;
  let d = isoDate;
  for (let i = 0; i < 10; i++) {
    d = nextIsoDate(d);
    if (isSessionDate(d)) return d;
  }
  return null;
}

export function eodRowIso(row) {
  return row ? normalizeDateToIso(row.isoDate || row.date || row.id) : "";
}

/** A hand-entered row: its date is one of the seed dates and it was not marked as recorded by the live system. */
export function isSeedRow(row) {
  if (!row) return false;
  if (row.source === "recorded") return false;
  return SEED_DATE_SET.has(eodRowIso(row));
}

/** A carry call (BTST / STBT). */
export function isCarryRow(row) {
  if (!row) return false;
  if (row.bias === "BULLISH" || row.bias === "BEARISH") return true;
  if (row.bias === "NEUTRAL") return false;
  return Boolean(row.verdict && (row.verdict.includes("BTST") || row.verdict.includes("STBT")));
}

function sortEodRowsDesc(rows) {
  return rows.sort((a, b) => (b.isoDate || "").localeCompare(a.isoDate || ""));
}

/** One row with ISO id/date normalised and `source` set; null when malformed or not a session date. */
export function normalizeEodRow(row) {
  if (!row || typeof row !== "object") return null;
  const iso = eodRowIso(row);
  if (!ISO_RE.test(iso) || !isSessionDate(iso)) return null;
  const clean = { ...row, isoDate: iso, id: `eod_${iso}`, date: formatIsoToDisplayDate(iso) };
  clean.source = isSeedRow(clean) ? "seed" : "recorded";
  return clean;
}

/** Normalise, drop non-session rows, dedupe by date (first occurrence wins), sort newest first. */
export function sanitizeEodHistory(rows, { limit = null } = {}) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = normalizeEodRow(r);
    if (n && !map.has(n.isoDate)) map.set(n.isoDate, n);
  }
  const out = sortEodRowsDesc(Array.from(map.values()));
  return limit ? out.slice(0, limit) : out;
}

/** Rows to keep in a device's localStorage: sanitised, without provisional (in-progress) rows. */
export function eodRowsForStorage(rows) {
  return sanitizeEodHistory(rows).filter(r => r.provisional !== true && r.outcome !== "IN_PROGRESS");
}

// ── Timeline helpers ─────────────────────────────────────────────────────────

function tickMinutes(pt) {
  const m = Number(pt?.minutes);
  if (Number.isFinite(m)) return m;
  const mm = /^(\d{1,2}):(\d{2})/.exec(String(pt?.time || ""));
  return mm ? Number(mm[1]) * 60 + Number(mm[2]) : NaN;
}

/** A real recorded tick: not synthetic, not marked isLiveTick:false, with a positive spot. */
function isRealTick(pt) {
  return Boolean(pt) && pt.synthetic !== true && pt.isLiveTick !== false && Number(pt.spot) > 0 && Number.isFinite(tickMinutes(pt));
}

function realTicksAsc(timeline, fromMins, toMins) {
  return (Array.isArray(timeline) ? timeline : [])
    .filter(pt => isRealTick(pt) && tickMinutes(pt) >= fromMins && tickMinutes(pt) <= toMins)
    .sort((a, b) => tickMinutes(a) - tickMinutes(b));
}

/** First real tick of a session's timeline: { spot, minutes, time } or null. */
export function sessionOpenTick(timeline, isoDate) {
  const t = eodSessionTimes(isoDate);
  if (t.openMins == null) return null;
  const first = realTicksAsc(timeline, t.openMins, t.closeMins)[0];
  if (!first) return null;
  const m = tickMinutes(first);
  return { spot: Number(first.spot), minutes: m, time: first.time || hhmmOf(m) };
}

/** NSE closing-auction freeze of the spot index (src/flowCalc.js SPOT_FREEZE_START_MINS / _END_MINS). */
export const EOD_SPOT_FREEZE_START_MINS = 915; // 15:15
export const EOD_SPOT_FREEZE_END_MINS = 930; // 15:30 (exclusive): the closing print appears from here

/**
 * The spot value repeated across the 15:15–15:29 freeze-window ticks (the most frequent value;
 * ties → the later one), or null when the window has no real tick.
 */
export function frozenWindowSpot(timeline) {
  const ticks = realTicksAsc(timeline, EOD_SPOT_FREEZE_START_MINS, EOD_SPOT_FREEZE_END_MINS - 1);
  if (!ticks.length) return null;
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const pt of ticks) {
    const v = Number(pt.spot);
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c >= bestCount) { best = v; bestCount = c; }
  }
  return best;
}

/**
 * The day's closing print (weekday sessions only): the LAST real tick (not synthetic,
 * isLiveTick !== false, spot > 0) with 15:30 ≤ minutes ≤ the 15:40 session close that is not
 * flagged `spotFrozen` and whose spot differs from the freeze-window value (older days carry no
 * flag). Never a tick inside 15:15–15:29. Null when no such tick exists, and always null for the
 * Muhurat date (its auction window is not modelled) — the caller then keeps the stored entry.
 * @returns {{ spot: number, minutes: number, time: string } | null}
 */
export function sessionClosingPrint(timeline, isoDate) {
  const t = eodSessionTimes(isoDate);
  if (t.kind !== "WEEKDAY") return null;
  const frozen = frozenWindowSpot(timeline);
  const candidates = realTicksAsc(timeline, EOD_SPOT_FREEZE_END_MINS, t.closeMins)
    .filter(pt => pt.spotFrozen !== true && (frozen == null || Number(pt.spot) !== frozen));
  const last = candidates[candidates.length - 1];
  if (!last) return null;
  const m = tickMinutes(last);
  return { spot: Number(last.spot), minutes: m, time: last.time || hhmmOf(m) };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Score a carry row against the next session's opening tick (existing sign conventions and note texts). */
export function resolveRowFromOpenTick(row, tick, nextIso) {
  const open = Number(tick?.spot);
  const entry = Number(row?.entrySpot);
  if (!(open > 0) || !(entry > 0)) return null;
  const diff = round2(open - entry);
  const resolvedFrom = { date: nextIso, time: tick.time || hhmmOf(tick.minutes), source: "timeline-open" };
  if (row.bias === "BULLISH") {
    return { ...row, nextDayOpen: open, gapPts: diff, outcome: diff > 0 ? "WIN" : "LOSS", notes: `${diff >= 0 ? "+" : ""}${diff} pts morning gap on open`, resolvedFrom };
  }
  if (row.bias === "BEARISH") {
    const pts = round2(-diff);
    return { ...row, nextDayOpen: open, gapPts: pts, outcome: diff < 0 ? "WIN" : "LOSS", notes: `${diff <= 0 ? "+" : ""}${pts} pts gap-down on open`, resolvedFrom };
  }
  return { ...row, nextDayOpen: open, gapPts: 0, outcome: "PRESERVED_CASH", notes: "Avoided overnight exposure; 100% cash preserved.", resolvedFrom };
}

/**
 * Resolve one open carry row from the next session's timeline.
 * status RESOLVED (WIN/LOSS), WAITING (no usable tick yet and the session may still provide one:
 * row unchanged) or UNRESOLVED (first tick too late to be the open, or `sessionOver` and no tick).
 */
export function resolveOpenFromTimeline(row, nextIso, timeline, { sessionOver = false } = {}) {
  const t = eodSessionTimes(nextIso);
  const tick = sessionOpenTick(timeline, nextIso);
  if (tick && t.openMins != null && tick.minutes <= t.openMins + EOD_OPEN_TICK_MAX_DELAY_MINS) {
    const resolved = resolveRowFromOpenTick(row, tick, nextIso);
    if (resolved) return { status: "RESOLVED", row: resolved };
    return { status: "WAITING", row };
  }
  if (tick) {
    return {
      status: "UNRESOLVED",
      row: { ...row, outcome: "UNRESOLVED", nextDayOpen: null, gapPts: null, notes: `${capitalise(EOD_OPEN_NOT_AVAILABLE_NOTE)}: the first recorded tick of ${nextIso} is at ${tick.time}, too late to be the open.` },
    };
  }
  if (sessionOver) {
    return {
      status: "UNRESOLVED",
      row: { ...row, outcome: "UNRESOLVED", nextDayOpen: null, gapPts: null, notes: `${capitalise(EOD_OPEN_NOT_AVAILABLE_NOTE)} (no recorded timeline for ${nextIso}).` },
    };
  }
  return { status: "WAITING", row };
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Resolve EVERY recorded PENDING row dated before today from the first real tick of its next
 * session (by the calendar; exchange holidays are not modelled):
 * - next session = today → today's timeline; no usable tick yet → stays PENDING;
 * - next session already over → `timelinesByDate[next]` when supplied, otherwise UNRESOLVED
 *   (the opening was not captured on that day, so it is not available now).
 * Seed (hand-entered) rows are never touched.
 */
export function resolvePendingEodRows(rows, { todayIso, todayTimeline = [], timelinesByDate = null }) {
  return rows.map(r => {
    if (!r || r.outcome !== "PENDING" || !(r.isoDate < todayIso) || isSeedRow(r)) return r;
    const next = nextSessionDate(r.isoDate);
    if (!next || next > todayIso) return r;
    if (next === todayIso) return resolveOpenFromTimeline(r, todayIso, todayTimeline, { sessionOver: false }).row;
    const tl = timelinesByDate && Array.isArray(timelinesByDate[next]) ? timelinesByDate[next] : [];
    return resolveOpenFromTimeline(r, next, tl, { sessionOver: true }).row;
  });
}

/** A past row still IN_PROGRESS never received a final verdict (no refresh at or after 15:38 that day). */
export function settleStaleProvisionalRows(rows, todayIso) {
  return rows.map(r => {
    if (!r || r.outcome !== "IN_PROGRESS" || !(r.isoDate < todayIso)) return r;
    const t = eodSessionTimes(r.isoDate);
    return {
      ...r,
      provisional: false,
      outcome: "UNRESOLVED",
      nextDayOpen: null,
      gapPts: null,
      notes: `${EOD_VERDICT_NOT_FINAL_PREFIX}: no refresh at or after ${t.finalMins != null ? hhmmOf(t.finalMins) : "the close"} IST that day (last snapshot ${r.time || "unknown"}). Not scored.`,
    };
  });
}

/** Chip text for an UNRESOLVED row. */
export function eodUnresolvedLabel(row) {
  return String(row?.notes || "").startsWith(EOD_VERDICT_NOT_FINAL_PREFIX) ? "Verdict not final" : "Open not recorded";
}

// ── Today's row ──────────────────────────────────────────────────────────────

/**
 * Today's row from the current EOD decision (server and client fallback use the same builder).
 * Returns null on a non-session day; before the session opens returns `existing` (or null).
 * - before finalisation: IN_PROGRESS, provisional, entrySpot = current spot (display only);
 * - at/after finalisation: outcome from the FINAL bias only (NEUTRAL → PRESERVED_CASH, carry →
 *   PENDING), entrySpot = spot at the first final snapshot, then frozen;
 * - a finalised row is not overwritten by a later request whose closing data is invalid.
 */
export function buildTodayEodRow({ todayIso, nowMins, timeStr, dayName, spot, floorStrike, roofStrike, eodDecision, existing = null, extra = null }) {
  if (!eodDecision || !isSessionDate(todayIso)) return null;
  const t = eodSessionTimes(todayIso);
  const prev = existing && eodRowIso(existing) === todayIso ? existing : null;
  if (!(Number(nowMins) >= t.openMins)) return prev;
  const isFinal = Number(nowMins) >= t.finalMins;
  const prevFinal = Boolean(prev && prev.provisional === false);
  const spotNum = Number(spot) > 0 ? Number(spot) : null;

  const snapshot = {
    id: `eod_${todayIso}`,
    isoDate: todayIso,
    date: formatIsoToDisplayDate(todayIso),
    dayName,
    time: timeStr,
    verdict: eodDecision.verdict,
    bias: eodDecision.bias,
    score: eodDecision.score,
    conviction: eodDecision.conviction,
    sizing: eodDecision.sizing,
    floor: floorStrike,
    roof: roofStrike,
    pcr: eodDecision.pcr,
    deltaPcr: eodDecision.deltaPcr,
    pcrWarning: eodDecision.pcrWarning,
    action: eodDecision.action,
    keyReasons: (eodDecision.audit || []).map(a => `${a.label} (${a.impact})`).join(" · "),
    ...(extra || {}),
    source: "recorded",
  };

  if (!isFinal) {
    if (prevFinal) return prev; // never downgrade a final row
    return {
      ...(prev || {}),
      ...snapshot,
      entrySpot: spotNum ?? prev?.entrySpot ?? null,
      nextDayOpen: null,
      gapPts: null,
      outcome: "IN_PROGRESS",
      provisional: true,
      notes: EOD_IN_PROGRESS_NOTE,
    };
  }

  if (prevFinal && !eodDecision.isClosingDataValid) {
    // Keep the finalised verdict and its frozen entry price.
    return { ...prev, floor: floorStrike || prev.floor, roof: roofStrike || prev.roof };
  }

  const isCarry = eodDecision.bias === "BULLISH" || eodDecision.bias === "BEARISH";
  const frozenEntry = prevFinal && Number(prev.entrySpot) > 0 ? Number(prev.entrySpot) : null;
  return {
    ...(prev || {}),
    ...snapshot,
    entrySpot: frozenEntry ?? spotNum ?? prev?.entrySpot ?? null,
    nextDayOpen: null,
    gapPts: null,
    outcome: isCarry ? "PENDING" : "PRESERVED_CASH",
    provisional: false,
    notes: `Decision finalized at ${timeStr || hhmmOf(Number(nowMins))} (verdict final from ${hhmmOf(t.finalMins)} IST; session close ${t.closeTimeStr} IST).`,
  };
}

/**
 * Server step: sanitise, settle stale in-progress rows, upsert today's row, resolve every PENDING
 * row whose next session is today from today's timeline, sort newest first.
 */
export function reconcileEodHistory({ history, todayIso, nowMins, timeStr, dayName, spot, floorStrike, roofStrike, eodDecision, todayTimeline = [], timelinesByDate = null, limit = 60 }) {
  let rows = sanitizeEodHistory(history);
  if (!isSessionDate(todayIso)) return rows.slice(0, limit);
  rows = settleStaleProvisionalRows(rows, todayIso);
  const idx = rows.findIndex(r => r.isoDate === todayIso);
  const existing = idx >= 0 ? rows[idx] : null;
  const todayRow = buildTodayEodRow({ todayIso, nowMins, timeStr, dayName, spot, floorStrike, roofStrike, eodDecision, existing });
  if (todayRow && todayRow !== existing) {
    if (idx >= 0) rows[idx] = todayRow;
    else rows.push(todayRow);
  }
  rows = resolvePendingEodRows(rows, { todayIso, todayTimeline, timelinesByDate });
  return sortEodRowsDesc(rows).slice(0, limit);
}

// ── One-off repairs of stored rows ───────────────────────────────────────────
//
// Entry-price rule (both repairs): a repaired row's entrySpot becomes the day's CLOSING PRINT
// (sessionClosingPrint: the last real, non-frozen tick from 15:30 to the 15:40 close). If there is
// no such tick, or the date is the Muhurat session, the stored entry is kept. A tick inside the
// 15:15–15:30 closing-auction freeze is never used (the first repair originally did — fixed here;
// repairEodHistoryV2 undoes what it changed in production).
// Rows written by the current repair carry `repairVersion: 2`.

export const EOD_REPAIR_VERSION = 2;
const REPAIR_VERDICT_NOTE = "Verdict as last recorded that day (not known whether it was the 15:38 final).";

function fmtPts(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0 ? String(Number(n)) : "none";
}

function signedPts(n) {
  const v = round2(n);
  return `${v >= 0 ? "+" : ""}${v}`;
}

function describeEntry(entry, print, kind) {
  if (print) return `entry ${fmtPts(entry)} = that day's closing print (${print.time} tick, after the 15:15–15:30 closing-auction freeze)`;
  const why = kind === "MUHURAT"
    ? "Muhurat session: no closing print derived"
    : "no post-15:30 closing print in that day's timeline";
  return `entry ${fmtPts(entry)} as originally recorded (${why})`;
}

function describeOutcome(row) {
  const rf = row.resolvedFrom;
  const side = row.bias === "BULLISH" ? "BTST" : row.bias === "BEARISH" ? "STBT" : "carry";
  if (row.outcome === "WIN" || row.outcome === "LOSS") {
    const where = rf && rf.date ? ` (${rf.date}${rf.time ? ` ${rf.time}` : ""} tick)` : "";
    return `${row.outcome} — next-session open ${row.nextDayOpen}${where}, index gap ${signedPts(Number(row.nextDayOpen) - Number(row.entrySpot))} pts = ${signedPts(row.gapPts)} pts for the ${side}`;
  }
  if (row.outcome === "UNRESOLVED") return `UNRESOLVED — ${EOD_OPEN_NOT_AVAILABLE_NOTE}`;
  if (row.outcome === "PENDING") return "PENDING — awaiting the next session's opening tick";
  if (row.outcome === "PRESERVED_CASH") return "PRESERVED_CASH — no carry";
  return String(row.outcome);
}

function composeRepairNote(row, { print, kind, extras = [] }) {
  const extra = extras.filter(Boolean);
  return `Repaired: ${describeEntry(row.entrySpot, print, kind)}${extra.length ? ` (${extra.join("; ")})` : ""}; outcome ${describeOutcome(row)}. ${REPAIR_VERDICT_NOTE}`;
}

/** Score an open carry row (entry already set) from its next session — shared by both repairs. */
async function resolveRepairedCarry(base, { tl, todayIso }) {
  const next = nextSessionDate(base.isoDate);
  let result;
  if (!next) {
    result = { status: "UNRESOLVED", row: { ...base, outcome: "UNRESOLVED", nextDayOpen: null, gapPts: null } };
  } else if (todayIso && next > todayIso) {
    result = { status: "WAITING", row: base };
  } else {
    const sessionOver = !(todayIso && next === todayIso);
    result = resolveOpenFromTimeline(base, next, await tl(next), { sessionOver });
  }
  if (result.status === "WAITING") {
    return { ...result.row, outcome: "PENDING", nextDayOpen: null, gapPts: null };
  }
  return result.row;
}

async function repairEodRow(row, { tl, todayIso }) {
  if (row.source === "seed" || row.isoDate < EOD_RECORDED_FROM_ISO) return { row, change: null };
  if (todayIso && row.isoDate >= todayIso) return { row, change: null };
  if (row.provisional === true || row.outcome === "IN_PROGRESS") return { row, change: null };
  if (row.outcome !== "PRESERVED_CASH") return { row, change: null };
  const carry = row.bias === "BULLISH" || row.bias === "BEARISH";
  const kind = eodSessionTimes(row.isoDate).kind;
  const oldEntry = Number(row.entrySpot);

  if (!carry) {
    if (kind !== "WEEKDAY") return { row, change: null };
    const print = sessionClosingPrint(await tl(row.isoDate), row.isoDate);
    if (print && (!(oldEntry > 0) || Math.abs(print.spot - oldEntry) > 1)) {
      const out = { ...row, entrySpot: print.spot, repaired: true, repairVersion: EOD_REPAIR_VERSION };
      out.notes = composeRepairNote(out, { print, kind, extras: [`stored entry ${fmtPts(oldEntry)} was not that day's closing print`] });
      return { row: out, change: { id: row.id, what: `entry ${fmtPts(oldEntry)} → ${print.spot} (closing print, ${print.time})` } };
    }
    return { row, change: null };
  }

  // Carry call stored as PRESERVED_CASH (outcome kept from an earlier no-carry snapshot).
  const print = kind === "WEEKDAY" ? sessionClosingPrint(await tl(row.isoDate), row.isoDate) : null;
  const entry = print ? print.spot : oldEntry;
  const entryChanged = print && (!(oldEntry > 0) || Math.abs(print.spot - oldEntry) > 0.001);
  const base = { ...row, entrySpot: entry > 0 ? entry : row.entrySpot, repaired: true, repairVersion: EOD_REPAIR_VERSION };
  const out = await resolveRepairedCarry(base, { tl, todayIso });
  out.notes = composeRepairNote(out, {
    print,
    kind,
    extras: [entryChanged ? `stored entry was ${fmtPts(oldEntry)}` : null, "the stored PRESERVED_CASH outcome had been kept from an earlier no-carry snapshot"],
  });
  return {
    row: out,
    change: { id: row.id, what: `${entryChanged ? `entry ${fmtPts(oldEntry)} → ${entry}; ` : ""}outcome PRESERVED_CASH → ${out.outcome}` },
  };
}

/** "entry spot <original> → <replaced>" from a first-repair note, or null when absent/unparsable. */
export function parseV1EntryChange(notes) {
  const m = /entry spot (\d+(?:\.\d+)?) → (\d+(?:\.\d+)?)/.exec(String(notes || ""));
  if (!m) return null;
  const original = Number(m[1]);
  const replaced = Number(m[2]);
  if (!(original > 0) || !(replaced > 0)) return null;
  return { original, replaced };
}

async function repairEodRowV2(row, { tl, todayIso }) {
  if (row.repaired !== true || row.repairVersion === EOD_REPAIR_VERSION || isSeedRow(row)) return { row, change: null };
  const parsed = parseV1EntryChange(row.notes);
  if (!parsed) return { row, change: null }; // the first repair did not change this row's entry (or the note is unreadable)
  const kind = eodSessionTimes(row.isoDate).kind;
  const print = kind === "WEEKDAY" ? sessionClosingPrint(await tl(row.isoDate), row.isoDate) : null;
  const entry = print ? print.spot : parsed.original;
  let out = { ...row, entrySpot: entry, repaired: true, repairVersion: EOD_REPAIR_VERSION };

  if (isCarryRow(row)) {
    if (Number(row.nextDayOpen) > 0) {
      // Re-score from the stored next-session open (no timeline read).
      const rf = row.resolvedFrom || null;
      const resolved = resolveRowFromOpenTick(out, { spot: Number(row.nextDayOpen), time: rf?.time || null, minutes: null }, rf?.date || nextSessionDate(row.isoDate));
      if (resolved) out = { ...resolved, resolvedFrom: rf || { date: nextSessionDate(row.isoDate), time: null, source: "stored-open" } };
    } else if (row.outcome === "UNRESOLVED") {
      out = { ...out, nextDayOpen: null, gapPts: null };
    } else if (row.outcome === "PENDING" || row.outcome === "PRESERVED_CASH") {
      out = await resolveRepairedCarry(out, { tl, todayIso });
    }
  }

  const extras = [`originally recorded entry ${parsed.original}`];
  if (Math.abs(parsed.replaced - entry) > 0.001) {
    extras.push(`an earlier repair had set ${parsed.replaced} from a tick at or before 15:30, before the closing print`);
  }
  out.notes = composeRepairNote(out, { print, kind, extras });
  return {
    row: out,
    change: { id: row.id, what: `entry ${fmtPts(row.entrySpot)} → ${entry}; outcome ${row.outcome} → ${out.outcome}` },
  };
}

async function runRowRepair(history, rowFn, getTimelineForDate, todayIso) {
  const input = Array.isArray(history) ? history : [];
  const dropped = input
    .map(r => eodRowIso(r))
    .filter(iso => ISO_RE.test(iso) && !isSessionDate(iso));
  const rows = sanitizeEodHistory(input);
  const cache = new Map();
  const tl = async (iso) => {
    if (!cache.has(iso)) {
      const t = await getTimelineForDate(iso);
      cache.set(iso, Array.isArray(t) ? t : []);
    }
    return cache.get(iso);
  };
  const out = [];
  const changes = [];
  for (const row of rows) {
    const { row: next, change } = await rowFn(row, { tl, todayIso });
    out.push(next);
    if (change) changes.push(change);
  }
  return { history: out, changes, dropped: Array.from(new Set(dropped)) };
}

/**
 * The current one-off repair (marker nifty_eod_history_repair_v1) — I/O injected:
 * getTimelineForDate(isoDate) → ticks[]. Drops non-session rows; for recorded rows from 2026-11-07
 * on, re-scores carry calls stored as PRESERVED_CASH (entry = the day's closing print when one
 * exists, else the stored entry; WIN/LOSS from the next session's opening tick, else UNRESOLVED)
 * and corrects NEUTRAL rows whose entry differs from the closing print by more than 1 point.
 * Seed rows are never modified. Idempotent. Throws if the timeline reader throws.
 * @returns {Promise<{ history: object[], changes: {id, what}[], dropped: string[] }>}
 */
export async function repairEodHistory({ history, getTimelineForDate, todayIso = null }) {
  return runRowRepair(history, repairEodRow, getTimelineForDate, todayIso);
}

/**
 * Second one-off repair (marker nifty_eod_history_repair_v2): for rows the first repair marked
 * `repaired` and whose entry it changed (note "entry spot <orig> → <new>"), restore the entry under
 * the closing-print rule starting from the original value, re-score from the stored nextDayOpen
 * (a timeline is read only for an open row that is resolvable), rewrite the note, set
 * repairVersion 2. Rows without that note, or already at version 2, are left alone. Idempotent.
 */
export async function repairEodHistoryV2({ history, getTimelineForDate, todayIso = null }) {
  return runRowRepair(history, repairEodRowV2, getTimelineForDate, todayIso);
}

/**
 * Run a repair at most once (claim = atomic marker, e.g. Redis SET NX). If the repair throws the
 * marker is released and the ORIGINAL history is returned unchanged; never throws.
 */
export async function runEodHistoryRepairOnce({ history, claim, release, getTimelineForDate, todayIso = null, repair = repairEodHistory }) {
  let claimed = false;
  try {
    claimed = Boolean(await claim());
  } catch (e) {
    return { history, ran: false, error: `claim failed: ${e?.message || e}` };
  }
  if (!claimed) return { history, ran: false };
  try {
    const r = await repair({ history, getTimelineForDate, todayIso });
    return { history: r.history, ran: true, changes: r.changes, dropped: r.dropped };
  } catch (e) {
    try { await release(); } catch (_) {}
    return { history, ran: false, error: e?.message || String(e) };
  }
}

// ── Statistics ───────────────────────────────────────────────────────────────

function tallyEodRows(rows) {
  const inProgress = rows.filter(r => r.outcome === "IN_PROGRESS").length;
  const unresolved = rows.filter(r => r.outcome === "UNRESOLVED").length;
  const counted = rows.filter(r => r.outcome !== "IN_PROGRESS" && r.outcome !== "UNRESOLVED");
  const carries = counted.filter(isCarryRow);
  const resolvedRows = carries.filter(r => RESOLVED_OUTCOMES.has(r.outcome));
  const wins = resolvedRows.filter(r => r.outcome === "WIN").length;
  const losses = resolvedRows.length - wins;
  const resolved = resolvedRows.length;
  const netPts = round2(resolvedRows.reduce((acc, r) => acc + (Number(r.gapPts) || 0), 0));
  return {
    sessions: rows.length - inProgress,
    carries: carries.length,
    resolved,
    wins,
    losses,
    pending: carries.filter(r => r.outcome === "PENDING").length,
    // Carry calls still stored as PRESERVED_CASH (the pre-repair bug): neither a carry result nor a cash day.
    carryStoredAsCash: carries.filter(r => r.outcome === "PRESERVED_CASH").length,
    cashDays: counted.filter(r => !isCarryRow(r) && r.outcome === "PRESERVED_CASH").length,
    inProgress,
    unresolved,
    netPts,
    winRatePct: resolved > 0 ? (wins / resolved) * 100 : null,
    tooFew: resolved < EOD_TOO_FEW_RESOLVED,
  };
}

/**
 * Track-record statistics, split into rows recorded by the running system (`live`, the headline)
 * and hand-entered seed rows (`seed`). IN_PROGRESS and UNRESOLVED rows are excluded from the win
 * rate and from cash days. Net points sum gapPts of resolved carries only.
 */
export function computeEodTrackStats(history) {
  const rows = (Array.isArray(history) ? history : []).filter(Boolean);
  return {
    live: tallyEodRows(rows.filter(r => !isSeedRow(r))),
    seed: tallyEodRows(rows.filter(r => isSeedRow(r))),
  };
}

/** "7/10 (70.0%)", with "too few to judge" below EOD_TOO_FEW_RESOLVED resolved carries. */
export function formatEodWinRate(tally) {
  if (!tally || !tally.resolved) return "no resolved carries yet — too few to judge";
  const base = `${tally.wins}/${tally.resolved} (${tally.winRatePct.toFixed(1)}%)`;
  return tally.tooFew ? `${base} — too few to judge` : base;
}

/**
 * Deduplicates and merges history arrays into a unified, chronologically sorted list.
 * Normalizes all date formats (04-11-2026, 04-Nov-2026, 2026-11-04) to standard ISO key
 * and display string "DD-MMM-YYYY".
 */
export function mergeEodHistory(localHistory = [], serverHistory = []) {
  const map = new Map();

  // 1. Server rows take precedence (first occurrence of a date wins; later duplicates only fill gaps).
  for (const item of Array.isArray(serverHistory) ? serverHistory : []) {
    const row = normalizeEodRow(item);
    if (!row) continue; // malformed or not a session date (closed weekend day)
    const existing = map.get(row.isoDate);
    map.set(row.isoDate, existing ? { ...row, ...existing } : row);
  }

  // 2. Local rows add dates the server did not send. For a date the server sent, a local row wins
  // only when it carries a WIN/LOSS resolution (manual "resolve open" on this device) and the server
  // row is still open (PENDING / UNRESOLVED). A local PRESERVED_CASH / IN_PROGRESS row never
  // overrides the server's row (that was how a carry call kept a stale "cash" outcome).
  for (const item of Array.isArray(localHistory) ? localHistory : []) {
    const row = normalizeEodRow(item);
    if (!row) continue;
    const existing = map.get(row.isoDate);
    if (!existing) {
      map.set(row.isoDate, row);
    } else if (RESOLVED_OUTCOMES.has(row.outcome) && OPEN_OUTCOMES.has(existing.outcome) && existing.provisional !== true) {
      map.set(row.isoDate, { ...existing, ...row, id: existing.id, date: existing.date, isoDate: existing.isoDate, source: existing.source });
    }
  }

  return sortEodRowsDesc(Array.from(map.values()));
}

/**
 * Loads and sanitizes local storage history, automatically purging duplicates
 * and stale seed records from older versions (v2/v3).
 */
export function loadAndSanitizeStorageHistory() {
  if (typeof window === "undefined" || !window.localStorage) {
    return CANONICAL_EOD_SEED_HISTORY;
  }

  try {
    // Check v5. Rows are passed through the same sanitiser as server rows (closed-weekend rows
    // dropped, `source` set); this device's provisional (in-progress) rows are not reloaded.
    const v5Raw = window.localStorage.getItem("options_scanner_eod_history_v5");
    if (v5Raw) {
      const parsed = JSON.parse(v5Raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return mergeEodHistory(eodRowsForStorage(parsed), CANONICAL_EOD_SEED_HISTORY);
      }
    }

    // Clean migration from older keys with unverified numbers
    window.localStorage.removeItem("options_scanner_eod_history_v2");
    window.localStorage.removeItem("options_scanner_eod_history_v3");
    window.localStorage.removeItem("options_scanner_eod_history_v4");
    window.localStorage.setItem("options_scanner_eod_history_v5", JSON.stringify(CANONICAL_EOD_SEED_HISTORY));
  } catch (err) {
    console.warn("Storage history sanitization failed:", err);
  }

  return CANONICAL_EOD_SEED_HISTORY;
}
