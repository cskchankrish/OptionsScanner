import React, { useEffect, useState } from "react";

/**
 * Carry check (shadow) for the Scorecard tab: the latest session's "hold overnight?" readings and
 * each metric's record against the next morning. Measurement only (GET /api/carry-check).
 */
const voteColour = (v, t) => (v === "BULLISH" ? "#16a34a" : v === "BEARISH" ? "#ef4444" : t.textMuted);
const voteText = (v) => (v === "BULLISH" ? "hold long" : v === "BEARISH" ? "hold short" : "no vote");
const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v}`);

export function CarryCheckPanel({ t, days = 30 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [policy, setPolicy] = useState("BRACKET_035_025");
  useEffect(() => {
    let live = true;
    fetch(`/api/carry-check?days=${days}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) { setData(j); setErr(j && j.ok === false ? j.error : null); } })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [days]);

  const cell = { padding: "6px 8px", borderBottom: `1px solid ${t.border}`, fontSize: 12, verticalAlign: "top" };
  const head = { ...cell, fontWeight: 800, color: t.textMuted, textTransform: "uppercase", fontSize: 10.5 };
  const latest = data?.sessions?.[0] || null;
  const s = data?.summary;
  const o = latest?.outcome;

  return (
    <div style={{ margin: "16px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800 }}>Carry check (shadow) — is it worth holding a position overnight?</span>
        <select value={policy} onChange={(e) => setPolicy(e.target.value)} style={{ background: t.surface, color: t.text, border: `1px solid ${t.border}`, borderRadius: 6, padding: "2px 6px", fontSize: 12 }}>
          {(data?.exitPolicies || []).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 11, color: t.textMuted, margin: "2px 0 6px" }}>
        Each metric votes at the close; the next morning measures holding in that direction against exiting at the 15:36 square-off.
        Hit = holding was ahead of the 15:36 exit under the selected exit policy. Measurement only — not a recommendation, and nothing here changes an order.
        {s ? ` ${s.measuredSessions} measured session(s), ${s.majorMoveSessions} with a major (≥ 0.35%) overnight move.` : ""}
      </div>
      {err && <div style={{ color: "#ef4444", fontSize: 12 }}>{err}</div>}

      {latest && (
        <div style={{ overflowX: "auto", marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, margin: "4px 0" }}>
            Readings at the {latest.date} close
            {o?.status === "MEASURED"
              ? ` · next session: 10:30 ${signed(o.at1030.pts)} pts vs the 15:36 exit (${o.refPrice}), best ${signed(o.high.pts)} / worst ${signed(o.low.pts)} before 11:00`
              : ` · next session: ${String(o?.status || "—").toLowerCase()}${o?.reason ? ` (${o.reason})` : ""}`}
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
            <thead><tr>{["Metric", "Vote", "Reading", "Result (selected exit)"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {(data.metrics || []).map(({ id, label }) => {
                const m = latest.metrics[id];
                const sc = latest.scores[id];
                const ps = sc?.policies?.[policy];
                return (
                  <tr key={id}>
                    <td style={cell}>{label}</td>
                    <td style={{ ...cell, fontWeight: 800, color: voteColour(m?.vote, t) }}>{voteText(m?.vote)}</td>
                    <td style={cell}>{m?.detail}</td>
                    <td style={{ ...cell, fontWeight: 800, color: ps?.status === "MEASURED" ? (ps.hit ? "#16a34a" : "#ef4444") : t.textMuted }}>
                      {sc?.status === "NO_VOTE" ? "—" : ps?.status === "MEASURED" ? `${ps.hit ? "HIT" : "MISS"} ${signed(ps.pts)}` : String(ps?.status || sc?.status || "—").toLowerCase()}
                      {ps?.status === "MEASURED" ? <div style={{ fontWeight: 500, fontSize: 10.5, color: t.textMuted }}>{String(ps.exit).toLowerCase()} {ps.at}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {s && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
            <thead><tr>{["Metric", "Hits / votes (selected exit)", "Avg pts", "Total pts", "Targets / stops", "Avg best", "Avg worst", "Major moves called"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {Object.entries(s.byMetric).map(([id, v]) => {
                const bp = v.byPolicy?.[policy];
                return (
                  <tr key={id}>
                    <td style={cell}>{v.label}</td>
                    <td style={cell}>
                      {bp?.votes ? `${bp.hits}/${bp.votes} (${Math.round(bp.hitRate * 100)}%)` : "no votes yet"}
                      {bp?.votes && bp.votes < s.minSample ? <div style={{ fontSize: 10.5, color: t.textMuted }}>too few to judge</div> : null}
                    </td>
                    <td style={{ ...cell, color: bp?.meanPts > 0 ? "#16a34a" : bp?.meanPts < 0 ? "#ef4444" : t.text }}>{signed(bp?.meanPts)}</td>
                    <td style={cell}>{signed(bp?.totalPts)}</td>
                    <td style={cell}>{bp?.votes ? `${bp.targets} / ${bp.stops}` : "—"}</td>
                    <td style={cell}>{signed(v.meanBestPts)}</td>
                    <td style={cell}>{signed(v.meanWorstPts)}</td>
                    <td style={cell}>{v.majorMovesCalled} of {s.majorMoveSessions}</td>
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
