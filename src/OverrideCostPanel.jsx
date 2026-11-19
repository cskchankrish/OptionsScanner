import React from "react";

/**
 * Override cost for the Scorecard tab (src/overrideCost.js). Measurement only.
 * "System minus you": positive = the override cost money. Rupees only in an authenticated view;
 * the public dashboard shows futures points.
 */
const signed = (v, unit = "") => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${unit}${Math.abs(v).toLocaleString("en-IN")}`);

export function OverrideCostPanel({ t, rolling, day }) {
  const cell = { padding: "6px 8px", borderBottom: `1px solid ${t.border}`, fontSize: 12, verticalAlign: "top" };
  const head = { ...cell, fontWeight: 800, color: t.textMuted, textTransform: "uppercase", fontSize: 10.5 };
  // cost colours: a positive cost (the override lost money) is red
  const costColour = (v) => (v > 0 ? "#ef4444" : v < 0 ? "#16a34a" : t.textSub);
  const rows = day?.rows || [];
  const inr = rolling && "totalInrEst" in rolling;

  return (
    <div style={{ margin: "16px 0" }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>Override cost — the system vs you</div>
      <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 6 }}>
        Every Algo position you closed by hand, against the same position left to the Algo's own rules (stop, T1 → stop to entry, T2, 15:36 square-off), plus trades you logged outside the system (the system's answer to those is no trade).
        Cost = system minus you, so <strong>positive means the override cost you</strong>. Points are NIFTY futures; manual-close rupees are an estimate (points × quantity × 0.5 delta).
      </div>
      {rolling && (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginBottom: 8 }}>
          <span>{rolling.sessions} session(s), {rolling.sessionsWithOverride} with an override</span>
          <span>{rolling.manualCloses} manual close(s), {rolling.outsideTrades} outside trade(s)</span>
          <span>Manual closes: <strong style={{ color: costColour(rolling.manualClosePts) }}>{signed(rolling.manualClosePts)} pts</strong></span>
          {inr && <span>Total: <strong style={{ color: costColour(rolling.totalInrEst) }}>{signed(rolling.totalInrEst, "₹")}</strong> est.</span>}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
          <thead><tr>{["Override", "You", "System", "Cost"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {!rows.length && <tr><td style={cell} colSpan={4}>No override on {day?.date || "this day"} — the system ran as designed.</td></tr>}
            {rows.map((x, i) => {
              if (x.kind === "MANUAL_CLOSE" && x.status !== "MEASURED") {
                return <tr key={i} style={{ color: t.textMuted }}><td style={cell}>Manual close {x.closedAt}</td><td style={cell} colSpan={3}>not measured: {x.reason}</td></tr>;
              }
              if (x.kind === "MANUAL_CLOSE") {
                return (
                  <tr key={i}>
                    <td style={cell}>Manual close<div style={{ fontSize: 10.5, color: t.textMuted }}>{String(x.signal || "").replace(/_/g, " ")} {x.direction === "BULLISH" ? "long" : "short"} · entry fut {x.entry.fut}</div></td>
                    <td style={cell}>closed {x.you.exit}: <strong>{signed(x.you.pts)} pts</strong>{x.youInr != null && <div style={{ fontSize: 10.5, color: t.textMuted }}>Algo result {signed(x.youInr, "₹")}</div>}</td>
                    <td style={cell}>{String(x.system.reason).replace(/_/g, " ").toLowerCase()} {x.system.exit}: <strong>{signed(x.system.pts)} pts</strong>{x.minutesEarly > 0 && <div style={{ fontSize: 10.5, color: t.textMuted }}>you left {x.minutesEarly} min early</div>}</td>
                    <td style={{ ...cell, fontWeight: 800, color: costColour(x.costPts) }}>{signed(x.costPts)} pts{x.costInrEst != null && <div>≈ {signed(x.costInrEst, "₹")}</div>}</td>
                  </tr>
                );
              }
              return (
                <tr key={i}>
                  <td style={cell}>Outside trade<div style={{ fontSize: 10.5, color: t.textMuted }}>{x.direction.toLowerCase()} {x.entryTime}{x.exitTime ? `–${x.exitTime}` : ""}{x.instrument ? ` · ${x.instrument}` : ""}{x.againstSystem ? " · against the last signal" : ""}</div></td>
                  <td style={cell}>{x.youInr != null ? <strong>{signed(x.youInr, "₹")}</strong> : "₹ hidden"}{x.futPts != null && <div style={{ fontSize: 10.5, color: t.textMuted }}>futures {signed(x.futPts)} pts</div>}</td>
                  <td style={cell}>no trade{x.lastSignal ? <div style={{ fontSize: 10.5, color: t.textMuted }}>last signal {String(x.lastSignal).replace(/_/g, " ")}</div> : null}</td>
                  <td style={{ ...cell, fontWeight: 800, color: costColour(x.costInr) }}>{x.costInr != null ? signed(x.costInr, "₹") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
