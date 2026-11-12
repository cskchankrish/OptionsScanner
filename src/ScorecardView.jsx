/**
 * Scorecard tab: today's events with outcomes and the rolling per-section table.
 * Every rate is shown with its sample size, and "too few to judge" below the minimum sample.
 * Data: GET /api/scorecard?date=… and ?days=30 (public view; rupee results need the secret).
 */
import React, { useEffect, useState } from "react";

const SECTION_LABEL = { FUSION: "Fusion (whole day)", TURN: "Turn Tracker", RADAR: "30-min radar", EOD: "EOD final verdict", EOD_SLOT: "EOD slots / flips", SIGNAL: "TradingView signals", TRADE: "Algo trades (₹)" };

function istToday() {
  const d = new Date(Date.now() + 330 * 60000);
  return d.toISOString().slice(0, 10);
}

const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 1000) / 10}%`);
const pts = (x) => (x === null || x === undefined ? "—" : `${x > 0 ? "+" : ""}${x}`);

function Rate({ s, t }) {
  if (!s) return <span>—</span>;
  return (
    <span>
      <strong>{s.hits}/{s.measurable}</strong>{" "}
      {s.measurable ? <span>({pct(s.hitRate)}, 95% {pct(s.wilson95.lo)}–{pct(s.wilson95.hi)})</span> : null}
      {s.tooFewToJudge && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 800, color: "#b45309" }}>too few to judge (n={s.measurable})</span>}
    </span>
  );
}

export function ScorecardView({ t, isDark }) {
  const [date, setDate] = useState(istToday());
  const [day, setDay] = useState(null);
  const [agg, setAgg] = useState(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    Promise.all([
      fetch(`/api/scorecard?date=${date}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/scorecard?days=${days}`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([d, a]) => {
      if (cancelled) return;
      setDay(d);
      setAgg(a);
    }).catch((e) => !cancelled && setErr(e.message));
    return () => { cancelled = true; };
  }, [date, days]);

  const cell = { padding: "6px 8px", borderBottom: `1px solid ${t.border}`, fontSize: 12, verticalAlign: "top" };
  const head = { ...cell, fontWeight: 800, color: t.textMuted, textTransform: "uppercase", fontSize: 10.5 };
  const rows = [];
  if (day?.events) for (const e of day.events) rows.push({ e, o: day.outcomes?.[e.id] });
  if (day?.eodFinal) rows.push({ e: day.eodFinal, o: day.eodOutcome });

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1400, margin: "0 auto", color: t.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 900 }}>📊 Scorecard</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ background: t.surface, color: t.text, border: `1px solid ${t.border}`, borderRadius: 6, padding: "4px 6px" }} />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ background: t.surface, color: t.text, border: `1px solid ${t.border}`, borderRadius: 6, padding: "4px 6px" }}>
          {[10, 20, 30, 60, 90].map((n) => <option key={n} value={n}>last {n} days</option>)}
        </select>
        <a href={`/api/scorecard?date=${date}&format=csv`} style={{ fontSize: 12, color: t.accent }}>day CSV</a>
        <a href={`/api/scorecard?days=${days}&format=csv`} style={{ fontSize: 12, color: t.accent }}>rolling CSV</a>
        <span style={{ fontSize: 11, color: t.textMuted }}>Measurement only — nothing here changes a decision.</span>
      </div>
      {err && <div style={{ color: "#ef4444" }}>{err}</div>}

      <div style={{ fontWeight: 800, margin: "8px 0 4px" }}>Rolling, per section ({agg?.sessions ?? 0} session(s){agg?.backfilledSessions ? `, ${agg.backfilledSessions} backfilled` : ""}; minimum sample {agg?.minSample ?? 30})</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
          <thead><tr>{["Section", "Hits / measurable", "Excluded (unmeasurable)", "Events", "+15m", "+30m", "+60m", "Close", "MFE 60m", "MAE 60m"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {agg && Object.entries(agg.sections).flatMap(([sec, s]) => [
              <tr key={sec}>
                <td style={cell}><strong>{SECTION_LABEL[sec] || sec}</strong><div style={{ fontSize: 10.5, color: t.textMuted }}>{s.rule}</div></td>
                <td style={cell}><Rate s={s} t={t} /></td>
                <td style={cell}>{s.excludedUnmeasurable}{s.pending ? ` · ${s.pending} pending` : ""}</td>
                <td style={cell}>{s.events}</td>
                <td style={cell}>{pts(s.meanForward.m15.pts)}</td>
                <td style={cell}>{pts(s.meanForward.m30.pts)}</td>
                <td style={cell}>{pts(s.meanForward.m60.pts)}</td>
                <td style={cell}>{pts(s.meanForward.close.pts)}</td>
                <td style={cell}>{pts(s.meanExcursion60.mfePts)}</td>
                <td style={cell}>{pts(s.meanExcursion60.maePts)}</td>
              </tr>,
              ...Object.entries(s.byStage || s.byDecision || {}).map(([k, v]) => (
                <tr key={`${sec}:${k}`} style={{ color: t.textSub }}>
                  <td style={{ ...cell, paddingLeft: 22 }}>{k.replace(/_/g, " ")}</td>
                  <td style={cell}><Rate s={v} t={t} /></td>
                  <td style={cell}>{v.excludedUnmeasurable}</td>
                  <td style={cell}>{v.events}</td>
                  <td style={cell}>{pts(v.meanForward.m15.pts)}</td>
                  <td style={cell}>{pts(v.meanForward.m30.pts)}</td>
                  <td style={cell}>{pts(v.meanForward.m60.pts)}</td>
                  <td style={cell}>{pts(v.meanForward.close.pts)}</td>
                  <td style={cell}>{pts(v.meanExcursion60.mfePts)}</td>
                  <td style={cell}>{pts(v.meanExcursion60.maePts)}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      <div style={{ fontWeight: 800, margin: "16px 0 4px" }}>
        {date}{day?.backfilled ? " (backfilled)" : ""}{day?.provisional ? " (in progress — outcomes so far)" : ""} · data {day?.dataQuality?.state || "—"} {day?.dataQuality?.coveragePct != null ? `${day.dataQuality.coveragePct}%` : ""}
      </div>
      {(day?.notes || []).map((n, i) => <div key={i} style={{ fontSize: 11, color: t.textMuted }}>{n}</div>)}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
          <thead><tr>{["Time", "Section", "Event", "Dir", "Fut", "Outcome", "+15m", "+60m", "Band first (60m)", "Data"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td style={cell} colSpan={10}>No events recorded for this date.</td></tr>}
            {rows.map(({ e, o }) => (
              <tr key={e.id}>
                <td style={cell}>{e.time}</td>
                <td style={cell}>{SECTION_LABEL[e.section] || e.section}</td>
                <td style={cell}>{e.type.replace(/_/g, " ")}{e.data?.category ? ` · ${e.data.category}` : ""}</td>
                <td style={cell}>{e.direction || "—"}</td>
                <td style={cell}>{e.futPrice ?? "—"}</td>
                <td style={{ ...cell, fontWeight: 800, color: o?.status === "MEASURED" ? (o.hit ? "#16a34a" : "#ef4444") : t.textMuted }}>
                  {o?.status === "MEASURED" ? (o.hit ? "HIT" : "MISS") : o?.status || "—"}
                  {o?.reason && <div style={{ fontWeight: 500, fontSize: 10.5 }}>{o.reason}</div>}
                </td>
                <td style={cell}>{o?.horizons?.[15]?.pts !== undefined ? pts(o.horizons[15].pts) : "—"}</td>
                <td style={cell}>{o?.horizons?.[60]?.pts !== undefined ? pts(o.horizons[60].pts) : o?.move0920Pts !== undefined ? `09:20 ${pts(o.move0920Pts)}` : "—"}</td>
                <td style={cell}>{o?.band60?.first || o?.first || "—"}</td>
                <td style={cell}>{e.dq?.ok === false ? "⚠️ gaps" : "ok"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
