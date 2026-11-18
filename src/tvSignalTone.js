/**
 * Tone of the "TV v4.3 BRIDGE" strip on the NIFTY flow page (pure, browser-safe).
 * Decisions that are never traded must not look like a buy or a sell:
 *   VETO     any VETO_* decision                 🚫 red    "vetoed — not traded"
 *   BLOCKED  BLOCKED_BY_ACTIVE_TRADE (0 lots)    ⛔ grey   "blocked — not traded"
 *   INFO     LOG_ONLY                            ℹ️ grey   "information only — not traded"
 * Everything else (EXECUTE_*, DOWNGRADE_TO_SCALP, fills, exits) keeps the direction badge as
 * before: 🟢 LONG / 🔴 SHORT.
 */
export function tvSignalTone(sig) {
  const d = String(sig?.decision || "");
  if (d.startsWith("VETO")) return { kind: "VETO", icon: "🚫", note: "vetoed — not traded" };
  if (d === "BLOCKED_BY_ACTIVE_TRADE") return { kind: "BLOCKED", icon: "⛔", note: "blocked — not traded" };
  if (d === "LOG_ONLY") return { kind: "INFO", icon: "ℹ️", note: "information only — not traded" };
  return sig?.direction === "LONG" ? { kind: "LONG", icon: "🟢", note: null } : { kind: "SHORT", icon: "🔴", note: null };
}
