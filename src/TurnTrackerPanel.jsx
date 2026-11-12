/**
 * Turn Tracker — primary element of the Smart Money Futures + Options Fusion panel
 * (payload.turnTracker, src/turnTracker.js). Display only: information, not a trade signal, never
 * sent to the Algo. The whole-day reading is rendered by the caller as a small reference line.
 */
import React from "react";

const STAGE_STYLE = {
  NO_TURN: { color: "#64748b", icon: "●" },
  EARLY: { color: "#d97706", icon: "◔" },
  LIKELY_TURN: { color: "#ea580c", icon: "◑" },
  CONFIRMED: { color: "#dc2626", icon: "⬤" },
};

const lots = (n) => {
  if (!Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const a = Math.abs(v);
  const s = v > 0 ? "+" : v < 0 ? "-" : "";
  return a >= 100000 ? `${s}${(a / 100000).toFixed(2)}L` : a >= 1000 ? `${s}${(a / 1000).toFixed(1)}k` : `${s}${Math.round(a)}`;
};
const absLots = (n) => lots(Math.abs(Number(n))).replace(/^\+/, "");
const sg = (n, d = 1) => (Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(d)}` : "—");

function Leg({ title, rows, t, isDark, isMobile, turned }) {
  return (
    <div style={{ flex: 1, minWidth: isMobile ? "100%" : 220, background: isDark ? "#0d1b2e" : "#ffffff", border: `1px solid ${turned ? "#ea580c66" : t.border}`, borderRadius: 8, padding: isMobile ? "8px 10px" : "10px 12px" }}>
      <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 800, color: t.textMuted, textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
        <span>{title}</span>
        <span style={{ color: turned ? "#ea580c" : t.textMuted }}>{turned ? "turned" : "not turned"}</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: isMobile ? 11 : 12, marginTop: 3 }}>
          <span style={{ color: t.textSub }}>{k}</span>
          <strong style={{ color: t.text, fontFamily: "monospace", textAlign: "right" }}>{v}</strong>
        </div>
      ))}
    </div>
  );
}

export function TurnTrackerPanel({ tracker, t, isDark, isMobile }) {
  if (!tracker) return null;
  if (tracker.status !== "OK") {
    const warn = tracker.status === "INSUFFICIENT_DATA";
    return (
      <div data-testid="turn-tracker" style={{ padding: "10px 12px", borderRadius: 8, marginBottom: 8, border: `1px solid ${warn ? "#d9770655" : t.border}`, background: warn ? (isDark ? "#291804" : "#fffbeb") : (isDark ? "#0d1b2e" : "#ffffff"), color: warn ? (isDark ? "#fbbf24" : "#b45309") : t.textSub, fontWeight: 700, fontSize: isMobile ? 11.5 : 12.5 }}>
        <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 800, textTransform: "uppercase", marginBottom: 2 }}>Turn Tracker</div>
        {tracker.message}
      </div>
    );
  }
  const st = STAGE_STYLE[tracker.stage] || STAGE_STYLE.NO_TURN;
  const dirColor = tracker.direction === "BEARISH" ? "#dc2626" : tracker.direction === "BULLISH" ? "#16a34a" : st.color;
  const color = tracker.stage === "NO_TURN" ? st.color : dirColor;
  const f = tracker.futuresLeg || {};
  const o = tracker.optionsLeg || {};
  const lvl = (x) => (x ? `${x.from} → ${x.to}${x.moved ? ` (${sg(x.moved, 0)})` : ""}` : "—");
  return (
    <div data-testid="turn-tracker" style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: isMobile ? 18 : 22, fontWeight: 900, color, letterSpacing: 0.3 }}>
          {st.icon} {tracker.stageLabel}{tracker.direction ? ` · ${tracker.direction}` : ""}
        </span>
        <span style={{ fontSize: isMobile ? 11.5 : 13, fontWeight: 700, color: t.textSub }}>
          since {tracker.reference?.time} {tracker.reference?.kind} at {tracker.reference?.price} → {tracker.current?.price} ({tracker.current?.time})
        </span>
      </div>
      <div style={{ fontSize: isMobile ? 11 : 12, color: t.textSub, margin: "3px 0 8px" }}>{tracker.reason}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Leg title="Futures leg" turned={f.turned} t={t} isDark={isDark} isMobile={isMobile} rows={[
          ["Price", `${sg(f.movePts, 1)} pts (${sg(f.movePct, 2)}%)`],
          ["Combined OI", `${sg(f.oiChange, 0)} (${sg(f.oiPct, 2)}%)`],
          ["Quadrant since extreme", String(f.quadrant || "—").replace(/_/g, " ")],
        ]} />
        <Leg title="Options leg" turned={o.turned} t={t} isDark={isDark} isMobile={isMobile} rows={[
          ["Call writing", `${lots(o.callLegDelta)} (${absLots(o.callFrom)}→${absLots(o.callTo)})`],
          ["Put writing", `${lots(o.putLegDelta)} (${absLots(o.putFrom)}→${absLots(o.putTo)})`],
          ["Driver", o.comparable === false ? "not comparable (15:30 print)" : `${o.driver || "—"}${o.dominantLeg ? ` · ${o.dominantLeg}` : ""}`],
          ["ΔPCR", `${o.deltaPcrAtExtreme ?? "—"} → ${o.deltaPcrNow ?? "—"}`],
          ["Floor / Roof", `${lvl(o.floor)} / ${lvl(o.roof)}`],
        ]} />
      </div>
      <div style={{ fontSize: isMobile ? 9.5 : 10.5, color: t.textMuted, marginTop: 6 }}>
        ℹ️ Information only — not a trade signal and not sent to the Algo. Thresholds: noise {tracker.thresholds?.noisePct}% price / {tracker.thresholds?.oiNoisePct}% OI; confirm {tracker.thresholds?.minMovePct}% price, {tracker.thresholds?.minOiPct}% OI, {tracker.thresholds?.minElapsedMin} min.
      </div>
    </div>
  );
}

/** Compact radar row (30-min radar area). */
export function TurnRadarRow({ tracker, isDark, isMobile, t }) {
  if (!tracker || !tracker.message || tracker.status === "BUILDING") return null;
  const active = tracker.status === "OK" && tracker.stage && tracker.stage !== "NO_TURN";
  const warn = tracker.status === "INSUFFICIENT_DATA";
  const color = active ? (tracker.direction === "BEARISH" ? "#ef4444" : "#16a34a") : warn ? (isDark ? "#fbbf24" : "#b45309") : t?.textMuted || "#64748b";
  return (
    <div data-testid="turn-radar-row" style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6, border: `1px solid ${active || warn ? `${color}55` : t?.border || "#e2e8f0"}`, background: isDark ? "#0a1322" : "#f8fafc", color, fontSize: isMobile ? 10.5 : 11.5, fontWeight: 700, lineHeight: 1.5 }}>
      {tracker.message}
    </div>
  );
}
