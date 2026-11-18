/**
 * Date and time stamp for a TradingView signal record, in IST (pure, never throws).
 *
 * Preference: `timestamp` (ISO, when the scanner received the alert) → "18-Nov-2026 · 11:20:08 IST".
 * Fallback: `istTime` when it is a chart bar time "YYYY-MM-DDTHH:MM" → "17-Nov-2026 · 11:20 IST".
 * Returns null when neither is usable.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

export function formatSignalStamp(sig) {
  try {
    const ms = Date.parse(sig?.timestamp);
    if (Number.isFinite(ms)) {
      // IST is UTC+05:30 with no daylight saving: shift and read the UTC fields.
      const d = new Date(ms + 330 * 60000);
      return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} IST`;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(sig?.istTime || ""));
    if (m) return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]} · ${m[4]}:${m[5]} IST`;
    return null;
  } catch (e) {
    return null;
  }
}
