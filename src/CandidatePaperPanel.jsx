import React, { useState } from "react";

/**
 * Candidate paper ledger for the Scorecard tab (src/candidatePaper.js). Shadow only: confirmed
 * synergy candidates traded as if real under the Algo's rules; no orders. Two tracks:
 * "As the Algo trades today" (a stop wider than the Algo's limit is rejected) and
 * "Stop capped" (the same trade with the stop pulled in to that limit).
 */
const TRACKS = [
  ["strict", "As the Algo trades today"],
  ["capped", "Stop capped at the Algo's limit"],
];
const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v}`);
const STATUS = {
  TAKEN: "taken",
  SKIPPED_STOP_TOO_WIDE: "not taken: stop too wide",
  SKIPPED_POSITION_OPEN: "not taken: paper position open",
  SKIPPED_REAL_TRADE_OPEN: "not taken: real trade open",
  DUPLICATE_OF_REAL: "not counted: same bar as a real signal",
  OPEN: "open",
  UNMEASURABLE: "unmeasurable",
};
const VERDICT = {
  NOT_ENOUGH_TRADES: "Not enough trades yet",
  FAILS_CRITERIA: "Does not meet the go-live checks",
  MEETS_CRITERIA: "Meets the go-live checks (your decision)",
};

function Ledger({ t, ledger, title }) {
  const [track, setTrack] = useState("strict");
  const L = ledger?.[track];
  if (!ledger || !L) return null;
  const cell = { padding: "5px 8px", borderBottom: `1px solid ${t.border}`, fontSize: 12, verticalAlign: "top", whiteSpace: "nowrap" };
  const head = { ...cell, fontWeight: 800, color: t.textMuted, textTransform: "uppercase", fontSize: 10.5 };
  const colour = (v) => (v > 0 ? "#16a34a" : v < 0 ? "#ef4444" : t.textSub);
  const s = L.taken;
  const rows = [...(L.trades || [])].reverse();
  return (
    <div style={{ margin: "8px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontWeight: 800 }}>{title}</span>
        <select value={track} onChange={(e) => setTrack(e.target.value)} style={{ background: t.surface, color: t.text, border: `1px solid ${t.border}`, borderRadius: 6, padding: "2px 6px", fontSize: 12 }}>
          {TRACKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12.5, marginBottom: 4 }}>
        <span><strong>Trades</strong> {s.n} <span style={{ color: t.textMuted }}>({L.goLive.progress} for the go-live check)</span></span>
        <span><strong>Net</strong> <span style={{ color: colour(s.totalPts), fontWeight: 800 }}>{signed(s.totalPts)} pts</span></span>
        <span><strong>Win rate</strong> {s.winRatePct == null ? "—" : `${s.winRatePct}%`} ({s.winners}W / {s.losers}L)</span>
        <span><strong>Profit factor</strong> {s.profitFactor ?? (s.profitFactorNote || "—")}</span>
        <span><strong>Avg R</strong> {s.avgR ?? "—"}</span>
        <span><strong>Max drawdown</strong> {s.maxDrawdownPts} pts</span>
      </div>
      <div style={{ fontSize: 11.5, color: t.textSub, marginBottom: 4 }}>
        <strong>Go-live: {VERDICT[L.goLive.verdict] || L.goLive.verdict}.</strong>{" "}
        {L.goLive.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.label}`).join(" · ")}
      </div>
      {track === "strict" && L.skipped.stopTooWide > 0 && (
        <div style={{ fontSize: 11.5, color: "#b45309", marginBottom: 4 }}>
          {L.skipped.stopTooWide} confirmed candidate(s) skipped because the stop was wider than {L.rules.maxRiskPts} pts — with their own stop they would have made {signed(L.skipped.stopTooWideHypotheticalPts)} pts.
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
            <thead>
              <tr>{["Date", "Time", "Side", "Status", "Entry (fut)", "Stop", "T1", "Exit", "Result", "R"].map((h) => <th key={h} style={head}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((x, i) => {
                const res = x.status === "TAKEN" ? x : x.status === "OPEN" ? { ...x, exit: `now ${x.lastAt}`, reason: "", pts: x.markPts } : x.hypothetical || null;
                return (
                  <tr key={`${x.date}-${x.time}-${i}`}>
                    <td style={cell}>{x.date}</td>
                    <td style={cell}>{x.time}</td>
                    <td style={cell}>{x.direction}</td>
                    <td style={{ ...cell, whiteSpace: "normal" }}>{STATUS[x.status] || x.status}{x.stopCapped ? ` (stop capped from ${x.riskSpotPts} pts)` : x.status === "SKIPPED_STOP_TOO_WIDE" ? ` (${x.riskSpotPts} pts)` : ""}</td>
                    <td style={cell}>{res?.entryFut ?? "—"}</td>
                    <td style={cell}>{res?.slFut ?? "—"}</td>
                    <td style={cell}>{res?.t1Fut ?? "—"}</td>
                    <td style={cell}>{res ? `${res.exit} ${res.reason}` : "—"}</td>
                    <td style={{ ...cell, color: colour(res?.pts), fontWeight: 800 }}>{res ? `${signed(res.pts)}${x.status === "TAKEN" ? "" : x.status === "OPEN" ? " (so far)" : " (if taken)"}` : "—"}</td>
                    <td style={cell}>{res?.r ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CandidatePaperPanel({ t, rolling, day }) {
  if (!rolling && !day) return null;
  return (
    <div style={{ margin: "16px 0" }}>
      <div style={{ fontWeight: 800, marginBottom: 2 }}>Candidate paper trades (shadow) — confirmed synergy candidates traded as if real</div>
      <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 4 }}>
        Paper only, no orders. Only candidates the real option chain confirmed, under the Algo's rules: one position at a time, stops wider than the Algo's limit rejected, managed minute by minute on futures (stop, T1 → stop to entry, T2, 15:36 square-off). Futures index points, not rupees.
        Go-live thresholds are starting values; switching anything live stays your decision.
      </div>
      {rolling && <Ledger t={t} ledger={rolling} title={`Running record (all ${rolling.strict?.sessions ?? 0} stored sessions)`} />}
      {day && (day.strict?.eligible || 0) > 0 && <Ledger t={t} ledger={day} title="This day" />}
    </div>
  );
}
