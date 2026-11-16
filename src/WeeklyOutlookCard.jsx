/**
 * Weekly Outlook card (SHADOW — display only, not traded). Reads GET /api/swing on mount and every
 * 5 minutes. Built from the daily swing summaries recorded at the close (src/swingSummary.js,
 * src/weeklyOutlook.js, docs/weekly-outlook.md). Renders with zero days, partial days only, or a
 * failed fetch.
 */
import React, { useCallback, useState } from "react";
import { useAutoRefresh } from "./useAutoRefresh.js";

const REGIME_STYLE = {
  TREND_UP: { color: "#16a34a", label: "TREND UP" },
  TREND_DOWN: { color: "#ef4444", label: "TREND DOWN" },
  RANGE: { color: "#2563eb", label: "RANGE" },
  BREAK_RISK_UP: { color: "#ea580c", label: "BREAK RISK ↑" },
  BREAK_RISK_DOWN: { color: "#db2777", label: "BREAK RISK ↓" },
  INSUFFICIENT_DATA: { color: "#64748b", label: "NOT ENOUGH DATA" },
};

const n0 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : String(Math.round(Number(v))));
const sgn = (v) => (Number(v) > 0 ? `+${v}` : String(v));

function GroupLine({ name, g, t, isMobile }) {
  if (!g) return null;
  let value;
  let color = t.textSub;
  if (!g.available) value = "—";
  else if (name === "Volatility") value = g.state || "—";
  else {
    value = sgn(g.score);
    color = g.score > 0 ? "#16a34a" : g.score < 0 ? "#ef4444" : t.textSub;
  }
  const text = g.available ? (g.reasons?.[0] || "") : (g.needs ? `needs ${g.needs}` : (g.reasons?.[0] || "not available"));
  return (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "78px 64px 1fr" : "96px 92px 1fr", gap: 8, alignItems: "baseline", fontSize: isMobile ? 11.5 : 12.5 }}>
      <span style={{ fontWeight: 800, color: t.textSub }}>{name}</span>
      <span style={{ fontFamily: "monospace", fontWeight: 900, color }}>{value}</span>
      <span style={{ color: g.available ? t.text : t.textMuted }}>{text}</span>
    </div>
  );
}

export function WeeklyOutlookCard({ t, isDark, isMobile }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/swing", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setData(j);
      setError(j?.ok === false ? j.error || "outlook unavailable" : null);
      return j?.ok === false ? { ok: false, error: j.error } : { ok: true };
    } catch (e) {
      setError(e?.message || String(e));
      return { ok: false, error: e?.message || String(e) };
    }
  }, []);
  useAutoRefresh({ refresh, intervalSec: 300, enabled: true, finalRefreshDelayMs: null });

  const o = data?.outlook || null;
  const st = REGIME_STYLE[o?.regime] || REGIME_STYLE.INSUFFICIENT_DATA;
  const boxStyle = {
    border: `1px solid ${st.color}55`, borderRadius: 12, padding: isMobile ? "10px 12px" : "12px 16px", marginBottom: 12,
    background: isDark ? "#0b1220" : "#ffffff",
  };
  const title = (
    <div style={{ fontSize: isMobile ? 10.5 : 11.5, fontWeight: 900, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
      Weekly Outlook — shadow, not traded
    </div>
  );

  if (!data && !error) {
    return <div data-testid="weekly-outlook" style={boxStyle}>{title}<div style={{ fontSize: 12, color: t.textMuted }}>Loading…</div></div>;
  }
  if (data && data.enabled === false) {
    return <div data-testid="weekly-outlook" style={boxStyle}>{title}<div style={{ fontSize: 12, color: t.textMuted }}>Switched off (SWING_ENABLED=false).</div></div>;
  }
  if (!o) {
    return (
      <div data-testid="weekly-outlook" style={boxStyle}>
        {title}
        <div style={{ fontSize: 12, fontWeight: 700, color: isDark ? "#fbbf24" : "#b45309" }}>Outlook unavailable{error ? `: ${error}` : ""}.</div>
      </div>
    );
  }

  const er = o.expectedRange;
  const lv = o.levels || {};
  const tally = data.tally?.total || { n: 0, hits: 0, pending: 0 };
  const byRegime = data.tally?.byRegime || {};
  const regimeTally = Object.entries(byRegime).filter(([, b]) => b.n || b.pending).map(([k, b]) => `${(REGIME_STYLE[k] || {}).label || k} ${b.hits}/${b.n}${b.pending ? ` (+${b.pending} pending)` : ""}`);
  const kv = (k, v) => (
    <span key={k} style={{ whiteSpace: "nowrap" }}><span style={{ color: t.textSub, fontWeight: 700 }}>{k}</span> <strong style={{ fontFamily: "monospace", color: t.text }}>{v}</strong></span>
  );

  return (
    <div data-testid="weekly-outlook" style={boxStyle}>
      {title}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: isMobile ? 11 : 12, fontWeight: 900, color: "#ffffff", background: st.color, borderRadius: 6, padding: "2px 8px", whiteSpace: "nowrap" }}>{st.label}</span>
        <span style={{ fontSize: isMobile ? 12 : 13.5, fontWeight: 700, color: t.text, flex: 1, minWidth: 200 }}>{o.headline}</span>
      </div>

      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: isMobile ? 11.5 : 12.5 }}>
        {kv("Expected range", er ? `${n0(er.low)}–${n0(er.high)} (±${n0(er.straddle)}, ${er.pctOfSpot ?? "?"}%) to ${er.expiry || "?"}` : "not recorded yet")}
        {kv("Pivot", lv.pivot?.value != null ? n0(lv.pivot.value) : "—")}
        {kv("Call wall", n0(lv.callWall))}
        {kv("Put wall", n0(lv.putWall))}
        {kv("Invalidation", lv.invalidation?.value != null ? `${lv.invalidation.side} ${n0(lv.invalidation.value)}` : (o.regime === "RANGE" ? "close outside range" : "—"))}
      </div>
      {lv.pivot?.basis && <div style={{ fontSize: isMobile ? 10.5 : 11, color: t.textMuted, marginTop: 2 }}>Pivot: {lv.pivot.basis}</div>}

      <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
        <GroupLine name="Price" g={o.groups?.price} t={t} isMobile={isMobile} />
        <GroupLine name="Futures" g={o.groups?.futures} t={t} isMobile={isMobile} />
        <GroupLine name="Options" g={o.groups?.options} t={t} isMobile={isMobile} />
        <GroupLine name="Volatility" g={o.groups?.volatility} t={t} isMobile={isMobile} />
      </div>

      <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${t.border}`, fontSize: isMobile ? 11 : 12, color: t.textSub, display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
        <span><strong>Confidence:</strong> {o.confidence}</span>
        <span><strong>As of:</strong> {o.asOf || "—"} · {o.daysUsed} session{o.daysUsed === 1 ? "" : "s"} used{o.partialDays?.length ? ` (${o.partialDays.length} partial)` : ""}</span>
        <span>
          <strong>Past outlooks:</strong> {tally.hits}/{tally.n} hit{tally.pending ? `, ${tally.pending} pending` : ""}
          {regimeTally.length ? ` · ${regimeTally.join(" · ")}` : ""}
        </span>
      </div>
      {(o.notes?.length > 0 || error) && (
        <div style={{ marginTop: 4, fontSize: isMobile ? 10.5 : 11, color: isDark ? "#fbbf24" : "#b45309" }}>
          {error ? `Last refresh failed: ${error}. ` : ""}{(o.notes || []).join(" ")}
        </div>
      )}
    </div>
  );
}
