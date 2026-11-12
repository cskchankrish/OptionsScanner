/**
 * Data-quality strip (top of the Nifty Flow tab) and inline per-panel markers.
 * Driven by payload.dataQuality (src/dataQuality.js, computed by the scanner on every refresh).
 *   green  "complete since 09:15"
 *   amber  gaps listed (history-based panels that include a gap are marked)
 *   red    stale snapshot
 *   grey   building (session just opened / no data yet)
 */
import React from "react";

const PALETTE = {
  OK: { fg: "#15803d", fgDark: "#86efac", bg: "#f0fdf4", bgDark: "#052e16", border: "#16a34a55", icon: "🟢" },
  GAPS: { fg: "#b45309", fgDark: "#fbbf24", bg: "#fffbeb", bgDark: "#291804", border: "#d9770655", icon: "🟠" },
  STALE: { fg: "#b91c1c", fgDark: "#fca5a5", bg: "#fef2f2", bgDark: "#2d0a0a", border: "#ef444455", icon: "🔴" },
  BUILDING: { fg: "#475569", fgDark: "#cbd5e1", bg: "#f8fafc", bgDark: "#0f172a", border: "#94a3b855", icon: "⚪" },
};

export function DataQualityStrip({ dataQuality, isDark, isMobile }) {
  if (!dataQuality || !dataQuality.state) return null;
  const p = PALETTE[dataQuality.state] || PALETTE.BUILDING;
  const gaps = Array.isArray(dataQuality.gaps) ? dataQuality.gaps : [];
  let text;
  if (dataQuality.state === "OK") {
    text = `Data complete since ${dataQuality.sessionStart} (${dataQuality.ticksToday}/${dataQuality.expectedTicks} ticks)`;
  } else if (dataQuality.state === "STALE") {
    text = `Data STALE — latest snapshot ${dataQuality.snapshotAgeSec ?? "?"}s old. History-based panels are not current.`;
  } else if (dataQuality.state === "GAPS") {
    text = `Data gaps since ${dataQuality.sessionStart}: ${gaps.map((g) => `${g.from}–${g.to}`).join(", ")} · ${dataQuality.coveragePct}% coverage. Panels whose window includes a gap say "not enough data".`;
  } else {
    text = dataQuality.summary || "Collecting data…";
  }
  return (
    <div
      role="status"
      data-testid="data-quality-strip"
      style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        background: isDark ? p.bgDark : p.bg, border: `1px solid ${p.border}`, color: isDark ? p.fgDark : p.fg,
        borderRadius: 8, padding: isMobile ? "6px 10px" : "7px 14px", marginBottom: 12,
        fontSize: isMobile ? 11 : 12.5, fontWeight: 700,
      }}
    >
      <span>{p.icon}</span>
      <span>{text}</span>
      {dataQuality.lastTickTime && <span style={{ fontWeight: 500, opacity: 0.8 }}>· last tick {dataQuality.lastTickTime}</span>}
    </div>
  );
}

/** Inline marker for one panel: renders only when that panel's window lacks coverage. */
export function PanelDataMarker({ panel, isDark, isMobile, style }) {
  if (!panel || panel.ok !== false) return null;
  return (
    <div
      data-testid="panel-data-marker"
      style={{
        marginTop: 6, padding: "4px 8px", borderRadius: 6,
        background: isDark ? "#291804" : "#fffbeb", border: "1px solid #d9770655",
        color: isDark ? "#fbbf24" : "#b45309", fontSize: isMobile ? 10.5 : 11.5, fontWeight: 700,
        ...style,
      }}
    >
      ⚠️ {panel.text || "not enough data for this window"}
    </div>
  );
}
