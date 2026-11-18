import React, { useState } from "react";

/**
 * Exit-rule shadow tables for the Scorecard tab (src/exitRuleShadow.js). Measurement only.
 * Rolling: rules A–E summed over the window's positions. Day: each position under each rule.
 */
const GROUPS = [
  ["all", "All positions"],
  ["signals", "Real TradingView signals"],
  ["candidates", "Shadow candidates"],
  ["executed", "Actually traded"],
];
const RULE_KEYS = ["BASELINE", "EXIT_CONFIRMED", "EXIT_LIKELY", "PROTECT_LIKELY", "EXIT_EARLY"];
const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v}`);

export function ExitRulesPanel({ t, rolling, dayRows }) {
  const [group, setGroup] = useState("all");
  const cell = { padding: "6px 8px", borderBottom: `1px solid ${t.border}`, fontSize: 12, verticalAlign: "top" };
  const head = { ...cell, fontWeight: 800, color: t.textMuted, textTransform: "uppercase", fontSize: 10.5 };
  const g = rolling?.[group];
  const colour = (v) => (v > 0 ? "#16a34a" : v < 0 ? "#ef4444" : t.textSub);
  const measured = (dayRows || []).filter((x) => x.result?.status === "MEASURED");
  const unmeasured = (dayRows || []).filter((x) => x.result?.status !== "MEASURED");

  return (
    <div style={{ margin: "16px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontWeight: 800 }}>Exit rules (shadow) — what to do when the Turn Tracker turns against a position</span>
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ background: t.surface, color: t.text, border: `1px solid ${t.border}`, borderRadius: 6, padding: "2px 6px", fontSize: 12 }}>
          {GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 6 }}>
        Every signal and candidate replayed minute by minute on futures, managed like the Algo (stop, T1 → stop to entry, T2, 15:36 square-off), under each rule.
        Futures index points, not rupees. Positions on the same day share one tracker reading, so they are not independent.
        {g ? ` ${g.measurable} measurable position(s) over ${rolling.sessions} session(s)${g.unmeasurable ? `, ${g.unmeasurable} excluded for data gaps` : ""}.` : ""}
        {g?.tooFewToJudge ? ` Too few to judge (needs ${g.minSample}).` : ""}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
          <thead><tr>{["Rule", "Total pts", "Mean pts", "vs baseline", "Better / worse / same", "Stops dodged", "Winners cut"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {!g && <tr><td style={cell} colSpan={7}>No data yet.</td></tr>}
            {g && RULE_KEYS.map((k) => {
              const r = g.rules[k];
              const base = k === "BASELINE";
              return (
                <tr key={k}>
                  <td style={cell}><strong>{r.id}</strong> {r.label}</td>
                  <td style={{ ...cell, fontWeight: 800, color: colour(r.totalPts) }}>{signed(r.totalPts)}</td>
                  <td style={cell}>{signed(r.meanPts)}</td>
                  <td style={{ ...cell, fontWeight: 800, color: base ? t.textMuted : colour(r.vsBaselineTotal) }}>{base ? "—" : signed(r.vsBaselineTotal)}</td>
                  <td style={cell}>{base ? "—" : `${r.betterThanBaseline} / ${r.worseThanBaseline} / ${r.sameAsBaseline}`}</td>
                  <td style={cell}>{base ? "—" : r.dodgedStops}</td>
                  <td style={cell}>{base ? "—" : r.cutWinners}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(dayRows || []).length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
            <thead><tr>{["Time", "Position", "A Baseline", "B Exit confirmed", "C Exit likely", "D Protect likely", "E Exit early"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {measured.map((x) => (
                <tr key={x.id}>
                  <td style={cell}>{x.time}</td>
                  <td style={cell}>
                    {String(x.grade || "").replace(/_/g, " ")} {x.direction === "BULLISH" ? "long" : "short"}
                    <div style={{ fontSize: 10.5, color: t.textMuted }}>{x.source === "CANDIDATE" ? "candidate" : "signal"}{x.category ? ` · ${x.category}` : ""}{x.executed ? " · traded" : ""} · entry fut {x.result.entry.fut}</div>
                  </td>
                  {RULE_KEYS.map((k) => {
                    const r = x.result.rules[k];
                    return (
                      <td key={k} style={cell}>
                        <strong style={{ color: colour(r.pts) }}>{signed(r.pts)}</strong>
                        <div style={{ fontSize: 10.5, color: t.textMuted }}>{r.exit} {String(r.reason).replace(/_/g, " ").toLowerCase()}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {unmeasured.map((x) => (
                <tr key={x.id} style={{ color: t.textMuted }}>
                  <td style={cell}>{x.time}</td>
                  <td style={cell} colSpan={6}>{String(x.grade || "").replace(/_/g, " ")} — not measured: {x.result?.reason || "unknown"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
