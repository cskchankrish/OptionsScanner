/**
 * Exit-rule shadow (owner 2026-11-18): which rule for reacting to a Turn Tracker reading AGAINST an
 * open position would have done best? Measurement only — nothing here feeds a decision, an alert
 * that tells anyone to act, or an order. Pure functions over a scorecard day document.
 *
 * Every SIGNAL and CANDIDATE event with entry / stop / targets is treated as a position opened at
 * that minute, managed the way the Algo manages a flow trade, and replayed minute by minute on the
 * recorded futures series under five rules:
 *
 *   A  BASELINE        ignore the tracker: stop, T1 → stop to entry, T2, square-off
 *   B  EXIT_CONFIRMED  as A, but exit at market when CONFIRMED appears against the position
 *   C  EXIT_LIKELY     as A, but exit when LIKELY TURN or CONFIRMED appears against it
 *   D  PROTECT_LIKELY  as A, but at LIKELY TURN or CONFIRMED against it move the stop to entry
 *   E  EXIT_EARLY      as A, but exit at the first stage of any kind against it
 *
 * Conventions (all chosen to match how the Algo actually trades, and stated so they can be argued):
 * - Prices are NIFTY FUTURES. Spot levels from the signal are shifted by the basis (futures − spot)
 *   at the entry tick, as the scorecard's signal rule does, so the 15:15–15:30 spot freeze never
 *   distorts anything.
 * - The Algo polls once a minute and exits at market, so every exit fills at that minute's futures
 *   price, not at the level itself (a gap through the stop costs the gap).
 * - Within one minute, price exits are checked before a tracker trigger (the stop is conservative).
 * - "Against" = a Turn Tracker stage event, recorded AFTER the entry minute and before the exit,
 *   whose direction is opposite to the position. A stage already showing at entry does not count;
 *   only a new reading does (the scorecard records stage transitions).
 * - Square-off at 15:36 (the Algo's flow square-off).
 * - Results are in futures index points in the position's direction. Rupees depend on the option
 *   bought (delta, theta) and are not modelled.
 * - A position whose window has a data gap is UNMEASURABLE and excluded.
 */
import { windowCoverage, hhmm, DQ_WINDOW_MAX_GAP_MIN } from "./dataQuality.js";

export const EXIT_RULES = [
  { id: "A", key: "BASELINE", label: "Hold to stop / target / square-off (baseline)" },
  { id: "B", key: "EXIT_CONFIRMED", label: "Exit on CONFIRMED against" },
  { id: "C", key: "EXIT_LIKELY", label: "Exit on LIKELY or CONFIRMED against" },
  { id: "D", key: "PROTECT_LIKELY", label: "Stop to entry on LIKELY or CONFIRMED against" },
  { id: "E", key: "EXIT_EARLY", label: "Exit on any stage against (EARLY included)" },
];
export const EXIT_SIM_SQUAREOFF_MINS = 936; // 15:36 IST, the Algo's flow square-off
export const EXIT_SIM_MIN_SAMPLE = 30;

const STAGE_RANK = { EARLY: 1, LIKELY_TURN: 2, CONFIRMED: 3 };
const TRIGGER = {
  BASELINE: null,
  EXIT_CONFIRMED: { minRank: 3, action: "EXIT" },
  EXIT_LIKELY: { minRank: 2, action: "EXIT" },
  PROTECT_LIKELY: { minRank: 2, action: "STOP_TO_ENTRY" },
  EXIT_EARLY: { minRank: 1, action: "EXIT" },
};

const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
const dirOf = (d) => (d === "BULLISH" ? 1 : d === "BEARISH" ? -1 : 0);

function futTicks(series) {
  const out = [];
  if (!series?.m) return out;
  for (let i = 0; i < series.m.length; i++) {
    if (Number(series.f?.[i]) > 0) out.push({ minutes: Number(series.m[i]), futPrice: Number(series.f[i]), spot: Number(series.s?.[i]) || null });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

/** One rule's path. Never throws. */
function runRule(ruleKey, { ticks, dir, entryF, slF, t1F, t2F, m0, squareoff, turns }) {
  const trig = TRIGGER[ruleKey];
  let stop = slF;
  let t1Hit = false;
  let last = null;
  for (const t of ticks) {
    if (t.minutes <= m0) continue;
    if (t.minutes > squareoff) break;
    last = t;
    const p = t.futPrice;
    // 1. price exits (stop before target in the same minute)
    if (dir > 0 ? p <= stop : p >= stop) {
      return { exitAt: t.minutes, exitPrice: p, reason: t1Hit && stop === entryF ? "BREAKEVEN" : stop !== slF ? "PROTECTED_STOP" : "STOP" };
    }
    if (!t1Hit && (dir > 0 ? p >= t1F : p <= t1F)) {
      t1Hit = true;
      stop = dir > 0 ? Math.max(stop, entryF) : Math.min(stop, entryF);
    }
    if (t1Hit && t2F != null && (dir > 0 ? p >= t2F : p <= t2F)) return { exitAt: t.minutes, exitPrice: p, reason: "T2" };
    // 2. tracker trigger at this minute's close
    if (trig) {
      const hit = turns.find((e) => e.minutes > m0 && e.minutes <= t.minutes && !e._used?.[ruleKey] &&
        dirOf(e.direction) === -dir && (STAGE_RANK[e.type] || 0) >= trig.minRank);
      if (hit) {
        if (trig.action === "EXIT") return { exitAt: t.minutes, exitPrice: p, reason: `TRACKER_${hit.type}`, trigger: { time: hit.time, stage: hit.type } };
        // STOP_TO_ENTRY: tighten only, once
        const tightened = dir > 0 ? Math.max(stop, entryF) : Math.min(stop, entryF);
        if (tightened !== stop) stop = tightened;
        (hit._used ||= {})[ruleKey] = true;
      }
    }
  }
  if (!last) return null;
  return { exitAt: last.minutes, exitPrice: last.futPrice, reason: "SQUARE_OFF" };
}

/**
 * Replays one SIGNAL / CANDIDATE event under every rule.
 * @returns {{status:"MEASURED"|"UNMEASURABLE", reason?, entry?, rules?}}
 */
export function simulateExitRules(event, series, turnEvents = [], { squareoff = EXIT_SIM_SQUAREOFF_MINS } = {}) {
  try {
    const d = event?.data || {};
    const dir = dirOf(event?.direction);
    if (!dir || !(Number(d.sl) > 0) || !(Number(d.t1) > 0)) return { status: "UNMEASURABLE", reason: "no direction, stop or T1" };
    const m0 = Number(event.minutes);
    if (!(m0 >= 555 && m0 < squareoff)) return { status: "UNMEASURABLE", reason: "outside the trading window" };
    const ticks = futTicks(series);
    let t0 = null;
    for (const t of ticks) if (t.minutes <= m0) t0 = t;
    if (!t0 || m0 - t0.minutes > DQ_WINDOW_MAX_GAP_MIN || !(t0.spot > 0)) return { status: "UNMEASURABLE", reason: "no futures/spot tick at the entry minute" };
    const basis = t0.futPrice - t0.spot;
    const entryF = t0.futPrice;
    const slF = Number(d.sl) + basis;
    const t1F = Number(d.t1) + basis;
    const t2F = Number(d.t2) > 0 ? Number(d.t2) + basis : null;
    if (dir > 0 ? !(slF < entryF && t1F > entryF) : !(slF > entryF && t1F < entryF)) {
      return { status: "UNMEASURABLE", reason: "levels inconsistent with the direction at entry" };
    }
    const turns = (turnEvents || [])
      .filter((e) => e && e.section === "TURN" && STAGE_RANK[e.type])
      .map((e) => ({ ...e, _used: undefined }))
      .sort((a, b) => a.minutes - b.minutes);
    const ctx = { ticks, dir, entryF, slF, t1F, t2F, m0: t0.minutes === m0 ? m0 : m0, squareoff, turns };
    const rules = {};
    let latestExit = m0;
    for (const r of EXIT_RULES) {
      for (const e of turns) e._used = undefined;
      const res = runRule(r.key, ctx);
      if (!res) return { status: "UNMEASURABLE", reason: "no futures ticks after the entry" };
      const pts = r2(dir * (res.exitPrice - entryF));
      rules[r.key] = { exit: hhmm(res.exitAt), exitPrice: r2(res.exitPrice), reason: res.reason, pts, ...(res.trigger ? { trigger: res.trigger } : {}) };
      latestExit = Math.max(latestExit, res.exitAt);
    }
    const c = windowCoverage(ticks, t0.minutes, latestExit, { label: `position window ${hhmm(t0.minutes)}–${hhmm(latestExit)}` });
    if (!c.ok) return { status: "UNMEASURABLE", reason: c.text };
    const base = rules.BASELINE.pts;
    for (const r of EXIT_RULES) rules[r.key].vsBaseline = r2(rules[r.key].pts - base);
    return {
      status: "MEASURED",
      entry: { time: hhmm(t0.minutes), fut: r2(entryF), basis: r2(basis), slFut: r2(slF), t1Fut: r2(t1F), t2Fut: r2(t2F) },
      rules,
    };
  } catch (e) {
    return { status: "UNMEASURABLE", reason: "error" };
  }
}

/** Every position of one scorecard day document, replayed. */
export function evaluateDayExitRules(doc, opts = {}) {
  const events = Array.isArray(doc?.events) ? doc.events : [];
  const turns = events.filter((e) => e.section === "TURN");
  const traded = new Set(events.filter((e) => e.section === "TRADE").map((e) => e.data?.tradeId).filter(Boolean));
  return events
    .filter((e) => e.section === "SIGNAL" || e.section === "CANDIDATE")
    .map((e) => ({
      date: doc.date,
      id: e.id,
      time: e.time,
      source: e.section,
      grade: e.data?.grade || e.data?.realGrade || e.type,
      direction: e.direction,
      category: e.data?.category || null,
      executed: Boolean(e.data?.tradeId && traded.has(e.data.tradeId)),
      result: simulateExitRules(e, doc.series, turns, opts),
    }));
}

function summarise(rows, minSample) {
  const m = rows.filter((x) => x.result?.status === "MEASURED");
  const out = { positions: rows.length, measurable: m.length, unmeasurable: rows.length - m.length, minSample, tooFewToJudge: m.length < minSample, rules: {} };
  for (const r of EXIT_RULES) {
    const pts = m.map((x) => x.result.rules[r.key].pts);
    const vs = m.map((x) => x.result.rules[r.key].vsBaseline);
    const baseStops = m.filter((x) => x.result.rules.BASELINE.reason === "STOP");
    out.rules[r.key] = {
      id: r.id,
      label: r.label,
      totalPts: r2(pts.reduce((a, b) => a + b, 0)),
      meanPts: pts.length ? r2(pts.reduce((a, b) => a + b, 0) / pts.length) : null,
      winners: pts.filter((p) => p > 0).length,
      losers: pts.filter((p) => p < 0).length,
      vsBaselineTotal: r2(vs.reduce((a, b) => a + b, 0)),
      vsBaselineMean: vs.length ? r2(vs.reduce((a, b) => a + b, 0) / vs.length) : null,
      betterThanBaseline: vs.filter((v) => v > 0).length,
      worseThanBaseline: vs.filter((v) => v < 0).length,
      sameAsBaseline: vs.filter((v) => v === 0).length,
      // the two things a trader feels: a stop it saved you from, and a winner it cut short
      dodgedStops: baseStops.filter((x) => x.result.rules[r.key].pts > x.result.rules.BASELINE.pts).length,
      cutWinners: m.filter((x) => x.result.rules.BASELINE.pts > 0 && x.result.rules[r.key].pts < x.result.rules.BASELINE.pts).length,
    };
  }
  return out;
}

/** Rolling summary across day documents, overall and split by source and by "actually traded". */
export function aggregateExitRules(days, { minSample = EXIT_SIM_MIN_SAMPLE, ...opts } = {}) {
  const rows = (Array.isArray(days) ? days : []).flatMap((d) => evaluateDayExitRules(d, opts));
  // A candidate and a real signal fired on the same bar with the same levels are ONE position
  // (17-Nov 11:20): count it once in the overall figures, keeping the real signal.
  const keyOf = (x) => {
    const e = x.result?.entry;
    return e ? `${x.date}|${x.time}|${x.direction}|${e.slFut}|${e.t1Fut}` : null;
  };
  const seen = new Set(rows.filter((x) => x.source === "SIGNAL").map(keyOf).filter(Boolean));
  const unique = rows.filter((x) => x.source === "SIGNAL" || !seen.has(keyOf(x)));
  return {
    shadow: true,
    note: "Measurement only. Futures index points per position; rupees depend on the option and are not modelled.",
    conventions: {
      prices: "NIFTY futures; signal spot levels shifted by the basis at entry",
      fills: "minute polling, exit at that minute's futures price",
      against: "a new Turn Tracker stage after entry, opposite to the position",
      squareoff: hhmm(opts.squareoff ?? EXIT_SIM_SQUAREOFF_MINS),
    },
    sessions: new Set(rows.map((x) => x.date)).size,
    // Positions on the same day share one tracker reading, so they are not independent: judge a
    // rule on sessions as well as positions.
    all: summarise(unique, minSample),
    signals: summarise(rows.filter((x) => x.source === "SIGNAL"), minSample),
    candidates: summarise(rows.filter((x) => x.source === "CANDIDATE"), minSample),
    executed: summarise(rows.filter((x) => x.executed), minSample),
  };
}

/** Telegram lines for one day (empty when the day had no measurable position). */
export function formatExitRuleLines(dayRows) {
  const m = (dayRows || []).filter((x) => x.result?.status === "MEASURED");
  if (!m.length) return [];
  const lines = [`• *Exit rules* (shadow, futures pts, ${m.length} position(s)):`];
  for (const r of EXIT_RULES) {
    const tot = r2(m.reduce((a, x) => a + x.result.rules[r.key].pts, 0));
    const vs = r2(m.reduce((a, x) => a + x.result.rules[r.key].vsBaseline, 0));
    lines.push(`  ${r.id} ${r.label}: ${tot >= 0 ? "+" : ""}${tot}${r.key === "BASELINE" ? "" : ` (${vs >= 0 ? "+" : ""}${vs} vs A)`}`);
  }
  return lines;
}
