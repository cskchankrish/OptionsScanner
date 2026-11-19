/**
 * Override cost (owner 2026-11-19): what did overriding the system cost, in points and rupees?
 * Measurement only — nothing here blocks, alerts to act, or places an order. Pure functions.
 *
 * Two kinds of override, scored against what the system itself would have done:
 *
 *   MANUAL_CLOSE  an Algo position closed by hand (the Algo reports MANUAL_CLOSE). The system's
 *                 counterfactual is the same position managed by the Algo's own rules (stop,
 *                 T1 → stop to entry, T2, 15:36 square-off) — exit-rule shadow rule A, replayed on
 *                 the recorded futures series. A manual close that converted the position into the
 *                 overnight carry is not an override.
 *   OUTSIDE       a trade taken with no system signal, logged by the owner (POST action
 *                 "outside_trade", scripts/log-outside-trade.mjs). The system's counterfactual is
 *                 no trade, so its cost is minus its own result.
 *
 * Cost is "system minus you": positive means the override cost money, negative means it saved money.
 *
 * Rupees for a manual close are an ESTIMATE: the points difference × quantity × an at-the-money
 * delta of 0.5 (theta and the option actually bought are not modelled). The Algo's real rupee
 * result for what you did is shown beside it. Outside trades use the rupee figure you logged.
 * Rupees appear only in authenticated views and the private Telegram.
 */
import { simulateExitRules } from "./exitRuleShadow.js";
import { hhmm } from "./dataQuality.js";

export const OVERRIDE_DELTA = 0.5;
export const OVERRIDE_LOT_QTY = 65; // NIFTY lot size (units per lot)

const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
const r0 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const dirOf = (d) => (d === "BULLISH" || d === "LONG" ? 1 : d === "BEARISH" || d === "SHORT" ? -1 : 0);
const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

/** "14:05" → 845; null when malformed. */
export function minutesOf(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** Last futures price at or before a minute (within 5 minutes), else null. */
function futAt(series, minutes) {
  let best = null;
  const m = series?.m || [];
  for (let i = 0; i < m.length; i++) {
    const f = Number(series.f?.[i]);
    if (!(f > 0)) continue;
    if (Number(m[i]) <= minutes) best = { minutes: Number(m[i]), fut: f };
    else break;
  }
  return best && minutes - best.minutes <= 5 ? best.fut : null;
}

/** Validates one owner-logged outside trade; returns { ok, trade } or { ok:false, error }. */
export function normaliseOutsideTrade(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const direction = String(t.direction || "").toUpperCase();
  if (!["LONG", "SHORT"].includes(direction)) return { ok: false, error: "direction must be LONG or SHORT (LONG = bought calls / long futures, SHORT = bought puts / short futures)" };
  const entryMin = minutesOf(t.entryTime);
  if (entryMin === null) return { ok: false, error: "entryTime must be HH:MM (IST)" };
  const exitMin = t.exitTime ? minutesOf(t.exitTime) : null;
  if (t.exitTime && (exitMin === null || exitMin < entryMin)) return { ok: false, error: "exitTime must be HH:MM, not before entryTime" };
  if (!finite(t.pnlInr)) return { ok: false, error: "pnlInr (your rupee result, before charges) is required" };
  return {
    ok: true,
    trade: {
      id: String(t.id || `out-${entryMin}-${direction}-${Math.abs(Math.round(Number(t.pnlInr)))}`).slice(0, 60),
      direction,
      entryTime: hhmm(entryMin),
      exitTime: exitMin !== null ? hhmm(exitMin) : null,
      pnlInr: r2(t.pnlInr),
      instrument: t.instrument ? String(t.instrument).slice(0, 40) : null,
      note: t.note ? String(t.note).slice(0, 200) : null,
    },
  };
}

/**
 * One day's overrides.
 * @param doc scorecard day document (raw when authenticated, else the public view)
 * @param outsideTrades owner-logged outside trades for the date
 * @param authed rupees are returned only when true
 */
export function evaluateDayOverrides(doc, outsideTrades = [], { authed = false } = {}) {
  const events = Array.isArray(doc?.events) ? doc.events : [];
  const turns = events.filter((e) => e.section === "TURN");
  const trades = events.filter((e) => e.section === "TRADE");
  const carryIds = new Set(trades.filter((e) => e.data?.kind === "CARRY").map((e) => e.data?.tradeId).filter(Boolean));
  const signals = events.filter((e) => e.section === "SIGNAL").sort((a, b) => a.minutes - b.minutes);
  const rows = [];

  for (const tr of trades) {
    const d = tr.data || {};
    if (d.kind !== "FLOW" || d.exitGrade !== "MANUAL_CLOSE") continue;
    if (carryIds.has(d.tradeId) || /carry/i.test(String(d.closeReason || ""))) continue;
    const sig = signals.find((s) => s.data?.tradeId && s.data.tradeId === d.tradeId);
    const base = { kind: "MANUAL_CLOSE", tradeId: d.tradeId || null, signal: sig ? `${sig.time} ${sig.type}` : null, direction: tr.direction, closedAt: tr.time };
    if (!sig) { rows.push({ ...base, status: "UNMEASURABLE", reason: "signal for this trade not recorded" }); continue; }
    const sim = simulateExitRules(sig, doc.series, turns);
    if (sim.status !== "MEASURED") { rows.push({ ...base, status: "UNMEASURABLE", reason: sim.reason }); continue; }
    const closeFut = futAt(doc.series, tr.minutes);
    if (closeFut === null) { rows.push({ ...base, status: "UNMEASURABLE", reason: "no futures tick at the close" }); continue; }
    const dir = dirOf(sig.direction);
    const youPts = r2(dir * (closeFut - sim.entry.fut));
    const sys = sim.rules.BASELINE;
    const costPts = r2(sys.pts - youPts);
    const qty = finite(d.qty) && Number(d.qty) > 0 ? Number(d.qty) : (finite(d.accounts) && Number(d.accounts) > 0 ? Number(d.accounts) : 1) * OVERRIDE_LOT_QTY;
    const row = {
      ...base,
      status: "MEASURED",
      entry: { time: sim.entry.time, fut: sim.entry.fut },
      you: { exit: tr.time, fut: r2(closeFut), pts: youPts },
      system: { exit: sys.exit, fut: sys.exitPrice, reason: sys.reason, pts: sys.pts },
      costPts,
      minutesEarly: Math.max(0, minutesOf(sys.exit) - tr.minutes),
    };
    if (authed) {
      row.qty = qty;
      row.youInr = finite(d.pnlInr) ? Number(d.pnlInr) : null;
      row.costInrEst = r0(costPts * qty * OVERRIDE_DELTA);
      row.systemInrEst = row.youInr !== null ? r0(row.youInr + row.costInrEst) : null;
    }
    rows.push(row);
  }

  for (const raw of Array.isArray(outsideTrades) ? outsideTrades : []) {
    const n = normaliseOutsideTrade(raw);
    if (!n.ok) continue;
    const t = n.trade;
    const em = minutesOf(t.entryTime);
    const last = [...signals].reverse().find((s) => s.minutes <= em && dirOf(s.direction));
    const dir = dirOf(t.direction);
    const fIn = futAt(doc?.series, em), fOut = t.exitTime ? futAt(doc?.series, minutesOf(t.exitTime)) : null;
    const row = {
      kind: "OUTSIDE",
      id: t.id,
      direction: t.direction,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      instrument: t.instrument,
      note: t.note,
      status: "MEASURED",
      lastSignal: last ? `${last.time} ${last.type} ${last.direction}` : null,
      againstSystem: last ? dirOf(last.direction) === -dir : null,
      futPts: fIn !== null && fOut !== null ? r2(dir * (fOut - fIn)) : null,
    };
    if (authed) {
      row.youInr = t.pnlInr;
      row.costInr = r2(-t.pnlInr);
    }
    rows.push(row);
  }

  const m = rows.filter((x) => x.status === "MEASURED");
  const closes = m.filter((x) => x.kind === "MANUAL_CLOSE");
  const outside = m.filter((x) => x.kind === "OUTSIDE");
  const sum = (a) => r2(a.reduce((s, v) => s + (Number(v) || 0), 0));
  const totals = {
    overrides: rows.length,
    manualCloses: rows.filter((x) => x.kind === "MANUAL_CLOSE").length,
    outsideTrades: outside.length,
    manualClosePts: sum(closes.map((x) => x.costPts)),
  };
  if (authed) {
    totals.manualCloseInrEst = r0(sum(closes.map((x) => x.costInrEst)));
    totals.outsideInr = r0(sum(outside.map((x) => x.costInr)));
    totals.totalInrEst = r0(totals.manualCloseInrEst + totals.outsideInr);
  }
  return { date: doc?.date || null, rows, totals };
}

/** Rolling: per-day totals and the running sum (oldest first). */
export function aggregateOverrides(dayResults) {
  const days = (Array.isArray(dayResults) ? dayResults : []).filter((d) => d && d.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const authed = days.some((d) => "totalInrEst" in d.totals);
  let runPts = 0, runInr = 0;
  const perDay = days.map((d) => {
    runPts += d.totals.manualClosePts || 0;
    if (authed) runInr += d.totals.totalInrEst || 0;
    return { date: d.date, ...d.totals, runningPts: r2(runPts), ...(authed ? { runningInrEst: r0(runInr) } : {}) };
  });
  return {
    shadow: true,
    note: "System minus you: positive = the override cost money. Manual-close rupees are estimates (points × qty × 0.5 delta).",
    sessions: days.length,
    sessionsWithOverride: days.filter((d) => d.totals.overrides > 0).length,
    manualCloses: days.reduce((a, d) => a + d.totals.manualCloses, 0),
    outsideTrades: days.reduce((a, d) => a + d.totals.outsideTrades, 0),
    manualClosePts: r2(runPts),
    ...(authed ? { totalInrEst: r0(runInr) } : {}),
    perDay,
  };
}

const sgn = (v, unit = "") => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${unit}${Math.abs(v).toLocaleString("en-IN")}`);

/** Private Telegram lines (rupees included). Empty when the day had no override. */
export function formatOverrideLines(day) {
  if (!day || !day.rows?.length) return [];
  const t = day.totals;
  const lines = [`• *Override cost* (system minus you; + = it cost you): ${t.totalInrEst != null ? `*${sgn(t.totalInrEst, "₹")}* est.` : `${sgn(t.manualClosePts)} pts`}`];
  for (const x of day.rows) {
    if (x.kind === "MANUAL_CLOSE") {
      if (x.status !== "MEASURED") { lines.push(`  – manual close ${x.closedAt}: not measured (${x.reason})`); continue; }
      lines.push(`  – ${x.signal}: you closed ${x.you.exit} (${sgn(x.you.pts)} pts${x.youInr != null ? `, ${sgn(x.youInr, "₹")}` : ""}); system ${x.system.reason} ${x.system.exit} (${sgn(x.system.pts)} pts) → cost ${sgn(x.costPts)} pts${x.costInrEst != null ? ` ≈ ${sgn(x.costInrEst, "₹")}` : ""}`);
    } else {
      lines.push(`  – outside trade ${x.direction} ${x.entryTime}${x.exitTime ? `–${x.exitTime}` : ""}${x.againstSystem ? " (against the last signal)" : x.lastSignal === null ? " (no system signal before it)" : ""}: ${x.youInr != null ? sgn(x.youInr, "₹") : "₹ —"}; system: no trade`);
    }
  }
  return lines;
}
