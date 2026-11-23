/**
 * Candidate paper ledger (owner 2026-11-23): shadow candidates that the REAL option chain confirmed
 * are paper-traded as if they were real signals, so they can earn (or not) a switch to live after
 * 20–30 trades. Measurement only — nothing here places an order, claims the trade slot, reaches
 * the Algo or changes a decision. Pure functions over scorecard day documents.
 *
 * Why: on 23-Nov-2026 NIFTY fell ~625 pts while the chart's Auto-mode call-writing proxy (futures
 * basis) stayed off all day, so the real SYNERGY_BEAR never fired; the SYNERGY_BEAR_CAND at 11:20
 * was CONFIRMED by the real chain (ΔPCR 0.35) but, being a candidate, only logged.
 *
 * "As if real" means the Algo's own rules, nothing more generous:
 *   - which:    candidate grades in CAND_PAPER_GRADES (default the two synergy candidates) with a
 *               verdict in CAND_PAPER_CATEGORIES (default CONFIRMED);
 *   - stop:     the Algo rejects a flow entry when |entry − stop| > max_r_pts (120 on 23-Nov-2026:
 *               "stop too wide: |entry − sl| 221.7 pts > flow max_r_pts 120") → SKIPPED_STOP_TOO_WIDE
 *               (its hypothetical result is still shown, so the cost of the rule is visible);
 *   - one at a time: a candidate arriving while the previous paper position is still open
 *               → SKIPPED_POSITION_OPEN (positions are square-off by 15:36, so days never overlap);
 *   - managed:  exactly the exit-rule shadow's BASELINE path (src/exitRuleShadow.js): NIFTY futures,
 *               spot levels shifted by the basis at entry, minute fills at the futures price, stop
 *               before target in the same minute, T1 → stop to entry, T2, 15:36 square-off.
 * Results are futures index points; R = points / initial stop distance (futures). Rupees depend on
 * the option bought and are not modelled.
 */
import { simulateExitRules, EXIT_SIM_SQUAREOFF_MINS } from "./exitRuleShadow.js";

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};
const list = (v, d) => {
  const s = String(v ?? "").trim();
  return s ? s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : d;
};
const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

export function getCandidatePaperConfig(env = process.env) {
  const e = env || {};
  return {
    grades: list(e.CAND_PAPER_GRADES, ["SYNERGY_BULL_CAND", "SYNERGY_BEAR_CAND"]),
    categories: list(e.CAND_PAPER_CATEGORIES, ["CONFIRMED"]),
    maxRiskPts: num(e.CAND_PAPER_MAX_R_PTS, 120), // the Algo's flow max_r_pts
    // REJECT = as the Algo trades today; CAP = the same trade with the stop pulled in to maxRiskPts
    stopPolicy: String(e.CAND_PAPER_STOP_POLICY || "REJECT").trim().toUpperCase() === "CAP" ? "CAP" : "REJECT",
    // go-live check: starting thresholds, stated so they can be argued with
    minTrades: Math.round(num(e.CAND_PAPER_MIN_TRADES, 30)),
    minProfitFactor: num(e.CAND_PAPER_MIN_PF, 1.5),
  };
}

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** One day's eligible candidates turned into paper trades (chronological). Never throws. */
export function paperTradesForDay(doc, cfg = getCandidatePaperConfig({})) {
  try {
    const events = Array.isArray(doc?.events) ? doc.events : [];
    const turns = events.filter((e) => e.section === "TURN");
    const eligible = events
      .filter((e) => e.section === "CANDIDATE" && cfg.grades.includes(String(e.type).toUpperCase()) && cfg.categories.includes(String(e.data?.category || "").toUpperCase()))
      .sort((a, b) => (a.minutes - b.minutes) || ((a.t ?? 0) - (b.t ?? 0)));
    // Real positions hold the Algo's single slot (review 23-Nov-2026): an executed real signal
    // occupies it from its entry to its exit, and a real signal on the same bar and side as a
    // candidate is the same position, already counted as real (not paper evidence).
    const traded = new Set(events.filter((e) => e.section === "TRADE").map((e) => e.data?.tradeId).filter(Boolean));
    const realSignals = events.filter((e) => e.section === "SIGNAL" && e.direction);
    const realBusy = realSignals
      .filter((e) => e.data?.tradeId && traded.has(e.data.tradeId))
      .map((e) => {
        const s = simulateExitRules(e, doc.series, turns);
        const p = s.status === "MEASURED" ? s.rules.BASELINE : null;
        const end = p ? (isOpenPath(p) ? Infinity : minutesOf(p.exit)) : Infinity;
        return { from: Number(e.minutes), to: end ?? Infinity, label: `${e.type} ${e.time}` };
      });
    const out = [];
    let busyUntil = -1; // minute the open paper position exits (Infinity while it is still open)
    for (const e of eligible) {
      const d = e.data || {};
      const entrySpot = Number(d.entry ?? e.spot);
      const riskSpot = Number(d.sl) > 0 && entrySpot > 0 ? r2(Math.abs(entrySpot - Number(d.sl))) : null;
      const base = {
        date: doc.date, time: e.time, minutes: e.minutes, grade: e.type, realGrade: d.realGrade || null,
        direction: e.direction === "BULLISH" ? "LONG" : e.direction === "BEARISH" ? "SHORT" : null,
        category: d.category || null, deltaPcr: d.deltaPcr ?? null,
        entrySpot: r2(entrySpot), sl: r2(d.sl), t1: r2(d.t1), t2: r2(d.t2), riskSpotPts: riskSpot,
      };
      const sim = simulateExitRules(e, doc.series, turns);
      const path = sim.status === "MEASURED" ? sim.rules.BASELINE : null;
      const hypo = path ? resultOf(sim, path) : null;
      if (!path) {
        out.push({ ...base, status: "UNMEASURABLE", reason: sim.reason || "not measurable" });
        continue;
      }
      const dup = realSignals.find((s) => Number(s.minutes) === Number(e.minutes) && s.direction === e.direction);
      if (dup) {
        out.push({ ...base, status: "DUPLICATE_OF_REAL", reason: `the real ${dup.type} fired on the same bar (counted as a real signal)`, hypothetical: hypo });
        continue;
      }
      const real = realBusy.find((b) => e.minutes >= b.from && e.minutes < b.to);
      if (real) {
        out.push({ ...base, status: "SKIPPED_REAL_TRADE_OPEN", reason: `a real trade (${real.label}) held the Algo's single slot`, hypothetical: hypo });
        continue;
      }
      if (e.minutes < busyUntil) {
        out.push({ ...base, status: "SKIPPED_POSITION_OPEN", reason: busyUntil === Infinity ? "a paper position is still open" : `a paper position was open until ${hhmmOf(busyUntil)}`, hypothetical: hypo });
        continue;
      }
      let row;
      if (riskSpot !== null && riskSpot > cfg.maxRiskPts) {
        if (cfg.stopPolicy !== "CAP") {
          out.push({ ...base, status: "SKIPPED_STOP_TOO_WIDE", reason: `stop ${riskSpot} pts > ${cfg.maxRiskPts} (the Algo would reject it)`, hypothetical: hypo });
          continue;
        }
        // CAP variant: the same trade with the stop pulled in to maxRiskPts from the entry
        const capped = r2(base.direction === "LONG" ? entrySpot - cfg.maxRiskPts : entrySpot + cfg.maxRiskPts);
        const simC = simulateExitRules({ ...e, data: { ...d, sl: capped } }, doc.series, turns);
        const pc = simC.status === "MEASURED" ? simC.rules.BASELINE : null;
        if (!pc) {
          out.push({ ...base, status: "UNMEASURABLE", reason: simC.reason || "not measurable with the capped stop" });
          continue;
        }
        row = { ...base, stopCapped: true, originalSl: base.sl, sl: capped, ...resultOf(simC, pc), originalStopResult: hypo, _path: pc };
      } else {
        row = { ...base, ...hypo, _path: path };
      }
      // Still open (the series ends before the square-off: today in progress, or a feed that stopped
      // early): shown marked to market, never counted as a closed trade (review 23-Nov-2026).
      const open = isOpenPath(row._path);
      delete row._path;
      if (open) {
        out.push({ ...row, status: "OPEN", reason: "still open", markPts: row.pts, pts: null, r: null, exit: null, exitFut: null, lastAt: row.exit, lastFut: row.exitFut });
        busyUntil = Infinity;
      } else {
        out.push({ ...row, status: "TAKEN" });
        busyUntil = minutesOf(row.exit) ?? busyUntil;
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

/** A BASELINE path that ended at the last tick before the square-off minute is still open. */
function isOpenPath(p) {
  const m = minutesOf(p?.exit);
  return p?.reason === "SQUARE_OFF" && m !== null && m < EXIT_SIM_SQUAREOFF_MINS;
}

function resultOf(sim, path) {
  const risk = Math.abs(sim.entry.fut - sim.entry.slFut);
  return {
    entryFut: sim.entry.fut, slFut: sim.entry.slFut, t1Fut: sim.entry.t1Fut, t2Fut: sim.entry.t2Fut,
    exit: path.exit, exitFut: path.exitPrice, reason: path.reason, pts: path.pts,
    r: risk > 0 ? r2(path.pts / risk) : null,
    ...(isOpenPath(path) ? { open: true } : {}),
  };
}

const hhmmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function stats(trades) {
  const pts = trades.map((x) => Number(x.pts));
  const wins = pts.filter((p) => p > 0), losses = pts.filter((p) => p < 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pts) { cum += p; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); }
  const rs = trades.map((x) => Number(x.r)).filter(Number.isFinite);
  return {
    n: pts.length,
    winners: wins.length,
    losers: losses.length,
    flat: pts.length - wins.length - losses.length,
    winRatePct: pts.length ? r2((wins.length / pts.length) * 100) : null,
    totalPts: r2(cum),
    avgPts: pts.length ? r2(cum / pts.length) : null,
    avgR: rs.length ? r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    profitFactor: gl > 0 ? r2(gw / gl) : null,
    profitFactorNote: gl > 0 ? null : gw > 0 ? "no losing trade yet" : "no closed trade",
    maxDrawdownPts: r2(maxDd),
    best: pts.length ? r2(Math.max(...pts)) : null,
    worst: pts.length ? r2(Math.min(...pts)) : null,
  };
}

/**
 * The ledger across day documents (any order). Returns every eligible candidate with its status,
 * statistics of the TAKEN trades, the two halves (are early and late results alike?), what the
 * 120-pt stop rule skipped, and the go-live check. Never throws.
 */
export function buildCandidateLedger(days, cfg = getCandidatePaperConfig({})) {
  const docs = (Array.isArray(days) ? days : []).filter((d) => d && d.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const rows = docs.flatMap((d) => paperTradesForDay(d, cfg));
  const taken = rows.filter((x) => x.status === "TAKEN");
  const half = Math.floor(taken.length / 2);
  const first = stats(taken.slice(0, half)), second = stats(taken.slice(half));
  const all = stats(taken);
  const wide = rows.filter((x) => x.status === "SKIPPED_STOP_TOO_WIDE" && x.hypothetical);
  const checks = [
    { key: "TRADES", label: `at least ${cfg.minTrades} paper trades`, pass: all.n >= cfg.minTrades, value: all.n },
    { key: "PROFIT", label: "net points positive", pass: all.totalPts > 0, value: all.totalPts },
    { key: "PF", label: `profit factor at least ${cfg.minProfitFactor}`, pass: all.profitFactor !== null ? all.profitFactor >= cfg.minProfitFactor : all.n > 0 && all.losers === 0, value: all.profitFactor },
    { key: "HALVES", label: "both halves of the record positive", pass: taken.length >= 2 && first.totalPts > 0 && second.totalPts > 0, value: [first.totalPts, second.totalPts] },
  ];
  const enough = checks[0].pass;
  const verdict = !enough ? "NOT_ENOUGH_TRADES" : checks.every((c) => c.pass) ? "MEETS_CRITERIA" : "FAILS_CRITERIA";
  return {
    shadow: true,
    note: "Paper only: confirmed shadow candidates traded as if real under the Algo's rules. No orders. Futures index points; rupees not modelled.",
    rules: {
      grades: cfg.grades, categories: cfg.categories, maxRiskPts: cfg.maxRiskPts, stopPolicy: cfg.stopPolicy,
      management: "exit-rule shadow BASELINE: futures, stop / T1 → stop to entry / T2 / 15:36 square-off, one position at a time",
    },
    sessions: docs.length,
    eligible: rows.length,
    open: rows.filter((x) => x.status === "OPEN").length,
    taken: all,
    halves: { first, second },
    skipped: {
      positionOpen: rows.filter((x) => x.status === "SKIPPED_POSITION_OPEN").length,
      realTradeOpen: rows.filter((x) => x.status === "SKIPPED_REAL_TRADE_OPEN").length,
      duplicateOfReal: rows.filter((x) => x.status === "DUPLICATE_OF_REAL").length,
      stopTooWide: wide.length,
      stopTooWideHypotheticalPts: r2(wide.reduce((a, x) => a + Number(x.hypothetical.pts), 0)),
      unmeasurable: rows.filter((x) => x.status === "UNMEASURABLE").length,
    },
    goLive: { verdict, checks, minTrades: cfg.minTrades, progress: `${all.n}/${cfg.minTrades}` },
    trades: rows,
  };
}

/**
 * Both tracks: "strict" = as the Algo trades today (a stop wider than maxRiskPts is rejected) and
 * "capped" = the same trades with such a stop pulled in to maxRiskPts (on 23-Nov-2026 the only
 * confirmed candidate had a 226-pt Supertrend stop: rejected by the Algo, +270 pts if held).
 */
export function buildCandidatePaper(days, env = process.env) {
  const cfg = getCandidatePaperConfig(env);
  return {
    strict: buildCandidateLedger(days, { ...cfg, stopPolicy: "REJECT" }),
    capped: buildCandidateLedger(days, { ...cfg, stopPolicy: "CAP" }),
  };
}

/** Telegram lines for one day (empty when the day had no eligible candidate). */
export function formatCandidatePaperLines(doc, cfg = getCandidatePaperConfig({})) {
  const rows = paperTradesForDay(doc, { ...cfg, stopPolicy: "REJECT" });
  if (!rows.length) return [];
  const capRows = paperTradesForDay(doc, { ...cfg, stopPolicy: "CAP" });
  const capOf = (x) => capRows.find((c) => c.minutes === x.minutes && c.grade === x.grade && c.status === "TAKEN");
  // Legacy Markdown: grades and reason codes contain underscores, so they go inside `code`
  // (review 23-Nov-2026: a bare SYNERGY_BEAR_CAND made Telegram reject the whole daily message).
  const code = (v) => "`" + String(v ?? "").replace(/`/g, "'") + "`";
  const sg = (v) => `${v >= 0 ? "+" : ""}${v}`;
  const lines = ["• *Candidate paper trades* (shadow, futures pts, no orders):"];
  for (const x of rows) {
    const head = `  ${x.time} ${x.direction} ${code(x.grade)}:`;
    if (x.status === "TAKEN") lines.push(`${head} ${sg(x.pts)} (${code(x.reason)} ${x.exit})`);
    else if (x.status === "OPEN") lines.push(`${head} still open, ${sg(x.markPts)} at ${x.lastAt}`);
    else if (x.status === "SKIPPED_STOP_TOO_WIDE") {
      const c = capOf(x);
      lines.push(`${head} not taken, stop ${x.riskSpotPts} pts > ${cfg.maxRiskPts}${x.hypothetical ? ` (own stop: ${sg(x.hypothetical.pts)}` : " ("}${c ? `; stop capped at ${cfg.maxRiskPts}: ${sg(c.pts)}` : ""})`);
    } else if (x.status === "SKIPPED_POSITION_OPEN" || x.status === "SKIPPED_REAL_TRADE_OPEN" || x.status === "DUPLICATE_OF_REAL") lines.push(`${head} not counted, ${String(x.reason).replace(/[_*`[]/g, " ")}`);
    else lines.push(`${head} unmeasurable (${String(x.reason).replace(/[_*`[]/g, " ")})`);
  }
  return lines;
}
