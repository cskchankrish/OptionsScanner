/**
 * "Updated HH:MM:SS IST · age" with an amber (stale) / red (last refresh failed) state during
 * market hours. Fed by useAutoRefresh; the decision is getFreshnessState (src/autoRefreshCore.js).
 */
import { formatAge, getFreshnessState } from "./autoRefreshCore.js";

export function DataFreshnessBadge({ t, isDark, isMobile, auto, live }) {
  const f = getFreshnessState({
    nowMs: auto.nowMs,
    lastSuccessAt: auto.lastSuccessAt,
    lastError: auto.lastError,
    intervalMs: auto.intervalMs,
    live,
  });

  const palette =
    f.level === "error"
      ? { fg: isDark ? "#fca5a5" : "#b91c1c", bg: isDark ? "#2d0a0a" : "#fee2e2", border: isDark ? "#7f1d1d" : "#fecaca", dot: "#ef4444" }
      : f.level === "stale"
      ? { fg: isDark ? "#fbbf24" : "#b45309", bg: isDark ? "#291e05" : "#fefce8", border: isDark ? "#78350f" : "#fef08a", dot: "#f59e0b" }
      : { fg: t.textMuted, bg: isDark ? "#0f172a" : "#f1f5f9", border: t.border, dot: "#22c55e" };

  const text =
    f.level === "pending"
      ? auto.inFlight ? "Updating…" : "Waiting for first update"
      : `Updated ${f.updatedAtIst} IST · ${formatAge(f.ageSec)} ago`;

  return (
    <div
      title={f.reason || (auto.lastError && !live ? `Last refresh failed: ${auto.lastError.message}` : "")}
      style={{
        display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
        fontSize: isMobile ? 10.5 : 11.5, color: palette.fg,
        background: palette.bg,
        padding: isMobile ? "4px 8px" : "5px 10px", borderRadius: 6,
        border: `1px solid ${palette.border}`,
        fontFamily: "monospace", fontWeight: f.level === "fresh" || f.level === "pending" ? 600 : 800,
      }}
    >
      <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: palette.dot }} />
      {(f.level === "error" || f.level === "stale") && <span>STALE ·</span>}
      <span>{text}</span>
      {f.reason && <span style={{ fontWeight: 600 }}>({f.reason})</span>}
    </div>
  );
}
