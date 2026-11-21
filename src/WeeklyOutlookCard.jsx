/**
 * Weekly Outlook card (SHADOW — display only, not traded). Reads GET /api/swing on mount and every
 * 5 minutes. Built from the daily swing summaries recorded at the close (src/swingSummary.js,
 * src/weeklyOutlook.js, docs/weekly-outlook.md). Renders with zero days, partial days only, or a
 * failed fetch.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAutoRefresh } from "./useAutoRefresh.js";

// Fast first paint (owner 2026-11-21: the card took 30 s+ to appear). The card used to mount only
// after /api/nifty-oi returned (it sits inside the EOD section), and only then start its own fetch.
// primeWeeklyOutlook() starts /api/swing as soon as the page opens; the card's first load reuses
// that request, and the last result is kept for re-mounts (tab switches).
let primed = null; // { at, promise }
let lastData = null;
const SWING_URL = "/api/swing";
async function fetchSwing() {
  const r = await fetch(SWING_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j && j.ok !== false) lastData = j;
  return j;
}
export function primeWeeklyOutlook() {
  if (typeof fetch !== "function") return null;
  if (!primed || Date.now() - primed.at > 60000) {
    const promise = fetchSwing();
    promise.catch(() => { primed = null; });
    primed = { at: Date.now(), promise };
  }
  return primed.promise;
}

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

const STEP_STYLE = {
  WARNING: { n: 1, label: "Warning", color: "#d97706" },
  INVALIDATED: { n: 2, label: "Invalidated", color: "#ef4444" },
  FLIPPED: { n: 3, label: "Narrative flipped", color: "#7c3aed" },
};

/** Invalidation ladder: where the view weakens, is wrong, and has flipped (src/weeklyOutlook.js). */
function LadderBlock({ ladder, t, isMobile, isDark }) {
  if (!ladder || !ladder.ladders?.length) return null;
  const n0l = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : Math.round(Number(v)).toLocaleString("en-IN"));
  const heading = (l) => (ladder.view === "BEARISH" ? "Levels that would prove the down view wrong" : ladder.view === "BULLISH" ? "Levels that would prove the up view wrong" : l.side === "above" ? "Range: upside break levels" : "Range: downside break levels");
  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      {ladder.ladders.map((l) => (
        <div key={l.side} style={{ border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 8px", background: isDark ? "#0f172a" : "#f8fafc" }}>
          <div style={{ fontSize: isMobile ? 10.5 : 11.5, fontWeight: 800, color: t.textSub, marginBottom: 4 }}>{heading(l)} — daily close {l.side}</div>
          {l.steps.length === 0 && <div style={{ fontSize: 11, color: t.textMuted }}>No structural level recorded on this side yet.</div>}
          {l.warningNote && <div style={{ fontSize: isMobile ? 10 : 10.5, color: t.textMuted, marginBottom: 2 }}>No warning step: {l.warningNote}.</div>}
          {l.steps.map((stp) => {
            const sty = STEP_STYLE[stp.key] || { n: "?", label: stp.key, color: t.textSub };
            const zone = stp.zone && stp.zone.low !== stp.zone.high ? ` (zone ${n0l(stp.zone.low)}–${n0l(stp.zone.high)})` : "";
            return (
              <div key={stp.key} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: isMobile ? 11.5 : 12.5, marginBottom: 2 }}>
                <span style={{ fontWeight: 900, color: "#fff", background: sty.color, borderRadius: 4, padding: "0 6px", fontSize: 10.5, whiteSpace: "nowrap" }}>{sty.n} {sty.label}</span>
                <strong style={{ fontFamily: "monospace", color: t.text }}>{l.side === "above" ? "above" : "below"} {n0l(stp.value)}</strong>
                <span style={{ color: t.textMuted }}>{stp.status === "ALREADY_BEYOND" ? "already crossed" : `${n0l(stp.distance)} pts away`}{zone}</span>
                <span style={{ color: t.textMuted, fontSize: isMobile ? 10.5 : 11 }}>{(stp.components || []).map((c) => `${c.note} ${n0l(c.value)}`).join(" · ")}</span>
              </div>
            );
          })}
        </div>
      ))}
      {ladder.volumeReference && (
        <div data-testid="volume-reference" style={{ fontSize: isMobile ? 10.5 : 11.5, color: t.textSub }}>
          <strong>Volume reference:</strong> {ladder.volumeReference.text} · {ladder.volumeReference.valueArea}
          {Number.isFinite(Number(ladder.volumeReference.closeVsVwap)) ? ` · close ${Math.abs(Math.round(ladder.volumeReference.closeVsVwap)).toLocaleString("en-IN")} pts ${ladder.volumeReference.closeVsVwap >= 0 ? "above" : "below"} the volume-weighted average` : ""}
        </div>
      )}
      {ladder.inputs && ladder.inputs.nearWallsRecorded === false && (
        <div style={{ fontSize: isMobile ? 10 : 10.5, color: t.textMuted }}>Near-money option walls are recorded from the next daily capture; this ladder uses price and volume levels only.</div>
      )}
    </div>
  );
}

const SETUP_STATUS = {
  IN_ZONE: { label: "IN ZONE", color: "#16a34a" },
  WAITING: { label: "WAITING", color: "#64748b" },
  BROKEN: { label: "ZONE BROKEN", color: "#ef4444" },
  BLOCKED: { label: "BLOCKED BY REGIME", color: "#94a3b8" },
  NO_DATA: { label: "NO DATA", color: "#94a3b8" },
};

/** Shadow option setups (src/outlookSetups.js): measured, never traded, not advice. */
function SetupsBlock({ setups, tally, t, isMobile, isDark }) {
  if (!setups || (!setups.call && !setups.put)) return null;
  const n0l = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : Math.round(Number(v)).toLocaleString("en-IN"));
  const px = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : `₹${Number(v).toFixed(Number(v) < 100 ? 1 : 0)}`);
  const fz = isMobile ? 11.5 : 12.5;
  const row = (s) => {
    if (!s) return null;
    const call = s.side === "CALL";
    const st = SETUP_STATUS[s.status] || { label: s.status, color: t.textSub };
    const o = s.option;
    const tl = tally?.[call ? "call" : "put"];
    return (
      <div key={s.side} style={{ border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 8px", background: isDark ? "#0f172a" : "#f8fafc", opacity: s.allowed ? 1 : 0.75 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: fz }}>
          <strong style={{ color: call ? "#16a34a" : "#ef4444" }}>{call ? "Calls near support" : "Puts near resistance"}</strong>
          <span style={{ fontWeight: 900, color: "#fff", background: st.color, borderRadius: 4, padding: "0 6px", fontSize: 10.5 }}>{st.label}</span>
          {s.triggered && <span style={{ fontWeight: 900, color: "#fff", background: "#7c3aed", borderRadius: 4, padding: "0 6px", fontSize: 10.5 }}>TRIGGERED (shadow)</span>}
        </div>
        {s.zone && (
          <div style={{ fontSize: fz, color: t.text, marginTop: 2 }}>
            Zone <strong style={{ fontFamily: "monospace" }}>{n0l(s.zone.low)}{s.zone.high !== s.zone.low ? `–${n0l(s.zone.high)}` : ""}</strong>
            {s.status === "WAITING" && Number.isFinite(Number(s.distance)) ? <span style={{ color: t.textMuted }}> ({n0l(s.distance)} pts away)</span> : null}
            {" · "}stop: {s.stop ? s.stop.basis : "—"}
            {" · "}T1 <strong style={{ fontFamily: "monospace" }}>{n0l(s.target?.value)}</strong>{s.target ? <span style={{ color: t.textMuted }}> ({s.target.note})</span> : null}
            {s.target2 ? <> · T2 <strong style={{ fontFamily: "monospace" }}>{n0l(s.target2.value)}</strong> <span style={{ color: t.textMuted }}>({s.target2.note})</span></> : null}
            {" · "}reward:risk <strong style={{ color: s.rrOk ? "#16a34a" : "#d97706" }}>{s.rr ?? "—"}</strong>
            {Number.isFinite(Number(s.rewardPts)) && Number.isFinite(Number(s.riskPts)) ? <span style={{ color: t.textMuted }}> ({n0l(s.rewardPts)} pts reward / {n0l(s.riskPts)} pts risk from {s.status === "IN_ZONE" ? "the close" : "the zone edge"} {n0l(s.entrySpot)})</span> : null}
          </div>
        )}
        {s.zoneComponents?.length > 0 && (
          <div style={{ fontSize: isMobile ? 10 : 10.5, color: t.textMuted }}>Zone from: {s.zoneComponents.map((c) => `${c.note} ${n0l(c.value)}`).join(" · ")}</div>
        )}
        {o && (
          <div style={{ fontSize: fz, color: t.text, marginTop: 2 }}>
            Option: <strong style={{ fontFamily: "monospace" }}>{o.expiry} {n0l(o.strike)} {o.type}</strong> now {px(o.ltp)} (Δ {Math.abs(o.delta)}, IV {o.ivPct}%{o.ivSource === "atm" ? " ATM" : ""}, {o.dte} days)
            <span style={{ color: t.textMuted }}> · est. {px(o.estAtEntry)} at the zone, {px(o.estAtTarget)} at T1, {px(o.estAtStop)} at the stop after {o.holdDays} days · option reward:risk {o.estRr ?? "—"}</span>
          </div>
        )}
        {s.reasons?.length > 0 && <div style={{ fontSize: isMobile ? 10 : 10.5, color: t.textMuted }}>{s.reasons.join(" ")}</div>}
        {tl && tl.n > 0 && (
          <div style={{ fontSize: isMobile ? 10 : 10.5, color: t.textSub }}>
            Measured so far: {tl.n} triggered · {tl.target} reached T1 · {tl.stop} stopped · {tl.open} open{tl.expired ? ` · ${tl.expired} expired` : ""}{tl.avgOptionPnlPct != null ? ` · average option result ${tl.avgOptionPnlPct > 0 ? "+" : ""}${tl.avgOptionPnlPct}%` : ""}
          </div>
        )}
      </div>
    );
  };
  return (
    <div data-testid="outlook-setups" style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <div style={{ fontSize: isMobile ? 10.5 : 11.5, fontWeight: 800, color: t.textSub }}>
        Option setups — shadow, measured, not advice{setups.setupExpiry ? ` · options priced on ${setups.setupExpiry}` : ""}
      </div>
      {setups.premium && (
        <div style={{ fontSize: isMobile ? 10.5 : 11.5, color: setups.premium.rich ? (isDark ? "#fbbf24" : "#b45309") : t.textSub }}>
          Premium: {setups.premium.note}
        </div>
      )}
      {row(setups.call)}
      {row(setups.put)}
      <div style={{ fontSize: isMobile ? 10 : 10.5, color: t.textMuted }}>
        Triggers when the regime allows the side, the close is inside the zone and reward:risk to T1 is at least {setups.rules?.minRr ?? 1.5}. Counted when T1 is touched or a daily close passes the stop, within {setups.rules?.horizonSessions ?? 15} sessions. Option estimates are Black–Scholes at the current IV; real results use the recorded option prices.
      </div>
    </div>
  );
}

export function WeeklyOutlookCard({ t, isDark, isMobile }) {
  const [data, setData] = useState(() => lastData);
  const [error, setError] = useState(null);
  const firstLoad = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const usePrimed = firstLoad.current;
      firstLoad.current = false;
      const j = usePrimed ? await primeWeeklyOutlook() : await fetchSwing();
      setData(j);
      setError(j?.ok === false ? j.error || "outlook unavailable" : null);
      return j?.ok === false ? { ok: false, error: j.error } : { ok: true };
    } catch (e) {
      setError(e?.message || String(e));
      return { ok: false, error: e?.message || String(e) };
    }
  }, []);
  const auto = useAutoRefresh({ refresh, intervalSec: 300, enabled: true, finalRefreshDelayMs: null });
  // The hook never refreshes on mount (its first scheduled run is one interval later), so load once
  // here, through the hook so its schedule starts from this load. Without this the card sat on
  // "Loading…" for up to 5 minutes (until a tab switch or focus happened to trigger a refresh).
  useEffect(() => {
    auto.refreshNow().then((r) => { if (r?.skipped) refresh(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {kv("Expected range", er ? `${n0(er.low)}–${n0(er.high)} (±${n0(er.straddle)}, ${er.pctOfSpot ?? "?"}%) to ${er.expiry || "?"}${o.horizon?.sessionsLeft != null ? `, ${o.horizon.sessionsLeft} session${o.horizon.sessionsLeft === 1 ? "" : "s"}` : ""}` : "not recorded yet")}
        {kv("Pivot", lv.pivot?.value != null ? n0(lv.pivot.value) : "—")}
        {kv("Call wall (whole chain)", n0(lv.callWall))}
        {kv("Put wall (whole chain)", n0(lv.putWall))}
      </div>
      {lv.pivot?.basis && <div style={{ fontSize: isMobile ? 10.5 : 11, color: t.textMuted, marginTop: 2 }}>Pivot: {lv.pivot.basis}</div>}
      <LadderBlock ladder={lv.ladder} t={t} isMobile={isMobile} isDark={isDark} />
      <SetupsBlock setups={o.setups} tally={data.tally?.setups} t={t} isMobile={isMobile} isDark={isDark} />

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
          {(() => { const r = (data.pastOutlooks || []).filter((p) => p.recomputed).length; return r ? ` · ${r} older snapshot${r === 1 ? "" : "s"} recomputed with the current rules` : ""; })()}
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
