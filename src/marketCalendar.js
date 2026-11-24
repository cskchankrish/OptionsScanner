/**
 * Market calendar: the single source of truth for which IST days are trading sessions.
 *
 * Weekends are closed. A Saturday or Sunday is a live session ONLY when its IST date is in the
 * explicit Muhurat (Diwali special session) date list. Mon–Fri are weekday sessions EXCEPT NSE
 * trading holidays (added 24-Nov-2026: the Guru Nanak Jayanti holiday ran as a session — pollers
 * fetched, an EOD verdict was written for the holiday and 23-Nov's no-carry check was graded with a
 * fake "next open"). A weekday Muhurat date is never closed by the holiday list.
 *
 * Muhurat list: DEFAULT_MUHURAT_DATES + env MUHURAT_DATES. Holiday list: DEFAULT_MARKET_HOLIDAYS +
 * env MARKET_HOLIDAYS (server only: the browser bundle sees the defaults, so keep the defaults
 * current — add the next year's NSE holiday list when NSE publishes it). Both comma-separated
 * YYYY-MM-DD. Pure module: no imports, safe in the browser bundle, where `process` may be undefined.
 */

export const DEFAULT_MUHURAT_DATES = Object.freeze(["2026-11-08"]);
// NSE trading holidays on weekdays (10-Nov-2026 Diwali Balipratipada: no NSE bar that day; 24-Nov-2026
// confirmed by that week's expiry moving to Monday 23-Nov; 25-Dec and 26-Jan are fixed national
// holidays). Extend with the NSE 2027 list when NSE publishes it.
export const DEFAULT_MARKET_HOLIDAYS = Object.freeze(["2026-11-24", "2026-12-25", "2027-01-26"]);

const IST_OFFSET_MS = 330 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(s) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function readEnv(name) {
  try {
    // eslint-disable-next-line no-undef
    if (typeof process === "undefined" || !process || !process.env) return "";
    return String(process.env[name] || "");
  } catch (e) {
    return "";
  }
}

/** The effective holiday list (default + MARKET_HOLIDAYS env), read on every call. */
export function getMarketHolidays() {
  return Array.from(new Set([...DEFAULT_MARKET_HOLIDAYS, ...parseMuhuratDates(readEnv("MARKET_HOLIDAYS"))])).sort();
}

export function isMarketHoliday(isoDate) {
  return isValidIsoDate(isoDate) && getMarketHolidays().includes(isoDate);
}

function readEnvMuhurat() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof process === "undefined" || !process || !process.env) return "";
    return String(process.env.MUHURAT_DATES || "");
  } catch (e) {
    return "";
  }
}

/** Parse a comma-separated YYYY-MM-DD list; malformed entries are ignored. */
export function parseMuhuratDates(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw.split(",").map(s => s.trim()).filter(isValidIsoDate);
}

/** The effective Muhurat date list (default + MUHURAT_DATES env), read on every call. */
export function getMuhuratDates() {
  return Array.from(new Set([...DEFAULT_MUHURAT_DATES, ...parseMuhuratDates(readEnvMuhurat())])).sort();
}

/** IST parts of an epoch-ms instant: { date: "YYYY-MM-DD", minutes: 0..1439, dow: 0=Sun..6=Sat }. */
export function istParts(nowMs = Date.now()) {
  const d = new Date(Number(nowMs) + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

/** Day of week (0=Sun..6=Sat) of an ISO date, or null when malformed. */
export function dowOfIsoDate(isoDate) {
  if (!isValidIsoDate(isoDate)) return null;
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

export function isMuhuratDate(isoDate) {
  return isValidIsoDate(isoDate) && getMuhuratDates().includes(isoDate);
}

/**
 * "WEEKDAY" (Mon–Fri, not an exchange holiday), "MUHURAT" (a Sat/Sun in the Muhurat list) or
 * "CLOSED" (any other Sat/Sun, a weekday exchange holiday, or a malformed date).
 */
export function getSessionKindForDate(isoDate) {
  const dow = dowOfIsoDate(isoDate);
  if (dow === null) return "CLOSED";
  if (dow >= 1 && dow <= 5) return isMarketHoliday(isoDate) && !isMuhuratDate(isoDate) ? "CLOSED" : "WEEKDAY";
  return isMuhuratDate(isoDate) ? "MUHURAT" : "CLOSED";
}

/** Session kind for an epoch-ms instant (IST date). */
export function getSessionKind(nowMs = Date.now()) {
  return getSessionKindForDate(istParts(nowMs).date);
}

/** The ISO date one day after isoDate. */
export function nextIsoDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** True when the IST day after nowMs is a weekend Muhurat session. */
export function isMuhuratTomorrow(nowMs = Date.now()) {
  return getSessionKindForDate(nextIsoDate(istParts(nowMs).date)) === "MUHURAT";
}

/**
 * True while a market session is live at nowMs (IST, inclusive bounds, minute resolution):
 * Mon–Fri 09:15–15:40, a Muhurat weekend date 14:00–16:00, any other weekend day closed.
 * Exchange holidays are not modelled (same as the rest of this module).
 */
export function isSessionLiveNow(nowMs = Date.now()) {
  const p = istParts(nowMs);
  const kind = getSessionKindForDate(p.date);
  if (kind === "WEEKDAY") return p.minutes >= 555 && p.minutes <= 940;
  if (kind === "MUHURAT") return p.minutes >= 840 && p.minutes <= 960;
  return false;
}

/**
 * Calendar-gated day of week for session logic: 0 ONLY on a Muhurat session day (the legacy
 * "Sunday = Muhurat" value), 6 on any closed weekend day (the legacy "Saturday = weekend closed"
 * value), the real 1..5 on weekdays.
 */
export function getSessionDayOfWeek(nowMs = Date.now()) {
  const p = istParts(nowMs);
  const kind = getSessionKindForDate(p.date);
  if (kind === "MUHURAT") return 0;
  if (kind === "CLOSED") return 6;
  return p.dow;
}
