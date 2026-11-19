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
      <div style={{ fontWeight: 800 }}>Carry check (shadow) — is it worth holding a position overnight?</div>
      <div style={{ fontSize: 11, color: t.textMuted, margin: "2px 0 6px" }}>
        Each metric votes at the close; the next morning measures holding in that direction against exiting at the 15:36 square-off.
        Hit = ahead at 10:30. Measurement only — not a recommendation, and nothing here changes an order.
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
            <thead><tr>{["Metric", "Vote", "Reading", "Result"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {(data.metrics || []).map(({ id, label }) => {
                const m = latest.metrics[id];
                const sc = latest.scores[id];
                return (
                  <tr key={id}>
                    <td style={cell}>{label}</td>
                    <td style={{ ...cell, fontWeight: 800, color: voteColour(m?.vote, t) }}>{voteText(m?.vote)}</td>
                    <td style={cell}>{m?.detail}</td>
                    <td style={{ ...cell, fontWeight: 800, color: sc?.status === "MEASURED" ? (sc.hit ? "#16a34a" : "#ef4444") : t.textMuted }}>
                      {sc?.status === "MEASURED" ? `${sc.hit ? "HIT" : "MISS"} ${signed(sc.at1030Pts)}` : sc?.status === "NO_VOTE" ? "—" : String(sc?.status || "—").toLowerCase()}
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
            <thead><tr>{["Metric", "Hits / votes", "Avg at 10:30", "Avg best", "Avg worst", "Major moves called", "Major moves against"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
            <tbody>
              {Object.entries(s.byMetric).map(([id, v]) => (
                <tr key={id}>
                  <td style={cell}>{v.label}</td>
                  <td style={cell}>
                    {v.votes ? `${v.hits}/${v.votes} (${Math.round(v.hitRate * 100)}%)` : "no votes yet"}
                    {v.votes ? <div style={{ fontSize: 10.5, color: t.textMuted }}>range {Math.round(v.wilson95.lo * 100)}–{Math.round(v.wilson95.hi * 100)}%{v.tooFewToJudge ? " · too few to judge" : ""}</div> : null}
                  </td>
                  <td style={{ ...cell, color: v.meanAt1030Pts > 0 ? "#16a34a" : v.meanAt1030Pts < 0 ? "#ef4444" : t.text }}>{signed(v.meanAt1030Pts)}</td>
                  <td style={cell}>{signed(v.meanBestPts)}</td>
                  <td style={cell}>{signed(v.meanWorstPts)}</td>
                  <td style={cell}>{v.majorMovesCalled} of {s.majorMoveSessions}</td>
                  <td style={cell}>{v.majorAgainst}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
