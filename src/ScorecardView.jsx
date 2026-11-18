/**
 * Scorecard tab: today's events with outcomes and the rolling per-section table.
 * Every rate is shown with its sample size, and "too few to judge" below the minimum sample.
 * Data: GET /api/scorecard?date=… and ?days=30 (public view; rupee results need the secret).
 */
import React, { useEffect, useRef, useState } from "react";
import { isSessionLiveNow } from "./marketCalendar.js";
import { useAutoRefresh } from "./useAutoRefresh.js";
import { DataFreshnessBadge } from "./DataFreshness.jsx";

const VARIANT_LABEL = { BEAR_TRAP_BASE: "Bear trap — current rule", BEAR_TRAP_STRICT: "Bear trap — tighter (shadow)", BULL_TRAP_BASE: "Bull trap — current rule", BULL_TRAP_STRICT: "Bull trap — tighter (shadow)" };
const SECTION_LABEL = { FUSION: "Fusion (whole day)", TURN: "Turn Tracker", RADAR: "30-min radar", TRAP_SHADOW: "Trap rules — current vs tighter (shadow)", EOD: "EOD final verdict", EOD_SLOT: "EOD slots / flips", SIGNAL: "TradingView signals", CANDIDATE: "Candidate alerts — real-chain verdict (shadow, no orders)", TRADE: "Algo trades (₹)", PLAN_DOC: "Plan document (Gemini) — half-day calls, shadow" };
const SPLIT_LABEL = {
  "category:CONFIRMED": "Confirmed by the real chain",
  "category:UNCONFIRMED": "Let through, not confirmed by the chain",
  "category:REJECTED": "Rejected (vetoed) by the real chain",
  "category:UNVERIFIABLE": "Unverifiable (no fresh chain / ΔPCR)",
  "grade:SYNERGY_BULL_CAND": "Bull synergy candidates",
  "grade:SYNERGY_BEAR_CAND": "Bear synergy candidates",
  "grade:BEAR_TRAP_BUY_CAND": "Bear trap (buy) candidates",
  "grade:BULL_TRAP_SELL_CAND": "Bull trap (sell) candidates",
  "half:FIRST": "First-half calls",
  "half:SECOND": "Second-half calls",
  "half:FULL": "Whole-day calls",
  "call:BULLISH": "Bullish calls (hit = window went up)",
  "call:BEARISH": "Bearish calls (hit = window went down)",
  "call:RANGE": "Range calls (hit = window stayed flat)",
  "conviction:HIGHEST": "Conviction HIGHEST",
  "conviction:HIGH": "Conviction HIGH",
  "conviction:MEDIUM": "Conviction MEDIUM",
  "conviction:LOW": "Conviction LOW",
};
/** IV-band sub-rows (SIGNAL / CANDIDATE), labelled with the window's cut-offs. Shadow measurement. */
function ivSplitsOf(s, cuts) {
  if (!s.byIv) return [];
  const label = {
    LOW: cuts ? `IV shadow — low (ATM IV ≤ ${cuts.lo}%)` : "IV shadow — low",
    MID: cuts ? `IV shadow — mid (${cuts.lo}–${cuts.hi}%)` : "IV shadow — mid",
    HIGH: cuts ? `IV shadow — high (> ${cuts.hi}%)` : "IV shadow — high",
    UNKNOWN: cuts ? "IV shadow — not recorded" : `IV shadow — bands need ≥ 3 IV readings`,
  };
  return Object.entries(s.byIv).map(([k, v]) => [`iv:${k}`, label[k] || k, v]);
}

/** Sub-rows of a section: [key, label, stats]. CANDIDATE has two splits (category and grade). */
function splitsOf(s, cuts = null) {
  return [...baseSplitsOf(s), ...ivSplitsOf(s, cuts)];
}

function baseSplitsOf(s) {
  if (s.byHalf || s.byCall || s.byConviction) {
    return ["half", "call", "conviction"].flatMap((p) => Object.entries(s[`by${p[0].toUpperCase()}${p.slice(1)}`] || {}).map(([k, v]) => [`${p}:${k}`, SPLIT_LABEL[`${p}:${k}`] || k, v]));
  }
  if (s.byCategory || s.byGrade) {
    return [
      ...Object.entries(s.byCategory || {}).map(([k, v]) => [`category:${k}`, SPLIT_LABEL[`category:${k}`] || k, v]),
      ...Object.entries(s.byGrade || {}).map(([k, v]) => [`grade:${k}`, SPLIT_LABEL[`grade:${k}`] || k, v]),
    ];
  }
  return Object.entries(s.byStage || s.byDecision || s.byVariant || {}).map(([k, v]) => [k, VARIANT_LABEL[k] || k.replace(/_/g, " "), v]);
}

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

  // Same two fetches as before; a sequence number drops responses for a superseded date/days.
  const seqRef = useRef(0);
  const load = async () => {
    const seq = ++seqRef.current;
    setErr(null);
    try {
      const [d, a] = await Promise.all([
        fetch(`/api/scorecard?date=${date}`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/scorecard?days=${days}`).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (seq !== seqRef.current) return { ok: true };
      setDay(d);
      setAgg(a);
      return d === null || a === null ? { ok: false, error: "HTTP error" } : { ok: true };
    } catch (e) {
      if (seq === seqRef.current) setErr(e.message);
      return { ok: false, error: e.message };
    }
  };

  // Live polling only while the market session is live AND the selected date is today (IST).
  const isLiveToday = date === istToday() && isSessionLiveNow(Date.now());
  const auto = useAutoRefresh({
    refresh: load,
    intervalSec: 60,
    enabled: () => date === istToday() && isSessionLiveNow(Date.now()),
    finalRefreshDelayMs: null, // no polling outside the live session
  });

  useEffect(() => {
    // Through the hook so the freshness time and schedule start here; if an auto refresh for the
    // previous selection is still in flight, load directly (its stale response is dropped).
    auto.refreshNow(load).then((r) => { if (r?.skipped) load(); });
    return () => { seqRef.current += 1; };
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
        <DataFreshnessBadge t={t} isDark={isDark} isMobile={false} auto={auto} live={isLiveToday} />
        {isLiveToday && <span style={{ fontSize: 11, color: t.textMuted, fontFamily: "monospace" }}>auto {Math.floor(auto.remainingSec / 60)}:{String(auto.remainingSec % 60).padStart(2, "0")}</span>}
      </div>
      {err && <div style={{ color: "#ef4444" }}>{err}</div>}

      <div style={{ fontWeight: 800, margin: "8px 0 4px" }}>Rolling, per section ({agg?.sessions ?? 0} session(s){agg?.backfilledSessions ? `, ${agg.backfilledSessions} backfilled` : ""}; minimum sample {agg?.minSample ?? 30})</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: t.surface }}>
          <thead><tr>{["Section", "Hits / measurable", "Excluded (unmeasurable)", "Events", "+15m", "+30m", "+60m", "Close", "MFE 60m", "MAE 60m"].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {agg && Object.entries(agg.sections).flatMap(([sec, s]) => [
              <tr key={sec}>
                <td style={cell}>
                  <strong>{SECTION_LABEL[sec] || sec}</strong><div style={{ fontSize: 10.5, color: t.textMuted }}>{s.rule}</div>
                  {s.outcomeMix && (
                    <div style={{ fontSize: 11, color: t.textSub, marginTop: 2 }}>
                      Windows went up {s.outcomeMix.UP} · down {s.outcomeMix.DOWN} · flat {s.outcomeMix.FLAT}
                      {s.notScored ? ` · ${s.notScored} unparsed call(s) not scored` : ""}{s.late ? ` · ${s.late} from late snapshots` : ""}
                    </div>
                  )}
                </td>
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
              ...splitsOf(s, agg.ivBands).map(([k, label, v]) => (
                <tr key={`${sec}:${k}`} style={{ color: t.textSub }}>
                  <td style={{ ...cell, paddingLeft: 22 }}>{label}</td>
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
                <td style={cell}>
                  {e.type.replace(/_/g, " ")}{e.data?.category ? ` · ${e.data.category}` : ""}
                  {e.section === "PLAN_DOC" && (
                    <div style={{ fontSize: 10.5, color: t.textMuted }}>
                      {e.data?.call} · {e.data?.phrase}{e.data?.conviction ? ` · ${e.data.conviction}` : ""}{e.data?.late ? " · late snapshot" : ""}
                      {o?.outcome ? ` · window ${o.refAt}–${o.endAt} ${o.movePct > 0 ? "+" : ""}${o.movePct}% (${o.outcome})` : ""}
                    </div>
                  )}
                </td>
                <td style={cell}>{e.direction || "—"}</td>
                <td style={cell}>{e.futPrice ?? "—"}</td>
                <td style={{ ...cell, fontWeight: 800, color: o?.status === "MEASURED" ? (o.hit ? "#16a34a" : "#ef4444") : t.textMuted }}>
                  {o?.status === "MEASURED" ? (o.hit ? "HIT" : "MISS") : o?.status || "—"}
                  {o?.reason && <div style={{ fontWeight: 500, fontSize: 10.5 }}>{o.reason}</div>}
                </td>
                <td style={cell}>{o?.horizons?.[15]?.pts !== undefined ? pts(o.horizons[15].pts) : "—"}</td>
                <td style={cell}>{o?.horizons?.[60]?.pts !== undefined ? pts(o.horizons[60].pts) : o?.move0920Pts !== undefined ? `${o.price0920At || "09:20"} ${pts(o.move0920Pts)}` : "—"}</td>
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
