/**
 * GET /api/swing?days=30   Weekly Outlook (SHADOW — display and measurement only).
 *
 * Reads the last `days` (1–120, default 30) calendar dates of nifty:swing:day:<date>; a date with
 * no swing summary but with a scorecard day document gets a partial summary derived from the
 * scorecard series (computed here, never written). Returns the current outlook, compact day
 * summaries, the stored daily outlook snapshots measured against the sessions after them, and a
 * per-regime tally. Public and read-only: no writes, no NSE call, no Telegram. Closed weekend
 * dates are skipped. See docs/weekly-outlook.md.
 */
import { getSwingConfig, loadSwingHistory, lastDates } from "../src/swingSummary.js";
import { computeWeeklyOutlook, evaluateOutlookOutcome, getOutlookConfig, REGIMES, OUTLOOK_HIT_RULES, OUTLOOK_HORIZON_RULE } from "../src/weeklyOutlook.js";
import { istOf, keys as scKeys } from "../src/scorecard.js";
import { profileFromSeries } from "../src/volumeProfile.js";
import { getSessionKindForDate } from "../src/marketCalendar.js";
import { evaluateSetupOutcome, tallySetups, getSetupConfig } from "../src/outlookSetups.js";

export const SWING_API_DEFAULT_DAYS = 30;
export const SWING_API_MAX_DAYS = 120;

async function defaultDeps() {
  const { redisRestCommand } = await import("./nifty-oi.js");
  const { scStoreFromCommand } = await import("../src/scorecard.js");
  const store = scStoreFromCommand(redisRestCommand);
  return { now: () => Date.now(), mget: (ks) => store.mget(ks), env: () => process.env };
}

export function clampDays(raw) {
  const n = Math.round(Number(raw));
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) return SWING_API_DEFAULT_DAYS;
  return Math.max(1, Math.min(SWING_API_MAX_DAYS, n));
}

const compactChain = (c) => (c ? { expiry: c.expiry, dte: c.dte, atm: c.atm, straddle: c.straddle, expectedRange: c.expectedRange, callWall: c.callWall, putWall: c.putWall, pcr: c.pcr } : null);

export function compactDay(d) {
  return {
    date: d.date,
    source: d.source || "capture",
    partial: Boolean(d.partial),
    coveragePct: d.coveragePct ?? null,
    spot: d.spot || null,
    fut: d.fut ? { open: d.fut.open, high: d.fut.high, low: d.fut.low, close: d.fut.close, oiClose: d.fut.oiClose, oiChangePct: d.fut.oiChangePct } : null,
    chains: { near: compactChain(d.chains?.near), nextWeekly: compactChain(d.chains?.nextWeekly), monthly: compactChain(d.chains?.monthly), setup: compactChain(d.chains?.setup) },
    notes: Array.isArray(d.notes) ? d.notes : [],
  };
}

export function tallyOutcomes(pastOutlooks) {
  const byRegime = {};
  for (const r of REGIMES) if (r !== "INSUFFICIENT_DATA") byRegime[r] = { n: 0, hits: 0, pending: 0 };
  for (const p of pastOutlooks) {
    const b = byRegime[p.regime];
    if (!b) continue;
    if (p.outcome?.status === "PENDING") b.pending += 1;
    else if (p.outcome?.hit === true || p.outcome?.hit === false) {
      b.n += 1;
      if (p.outcome.hit) b.hits += 1;
    }
  }
  const total = Object.values(byRegime).reduce((a, b) => ({ n: a.n + b.n, hits: a.hits + b.hits, pending: a.pending + b.pending }), { n: 0, hits: 0, pending: 0 });
  return { byRegime, total };
}

export function createSwingHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed. Use GET." });
    const needDefaults = !overrides.mget || !overrides.now;
    const deps = { ...(needDefaults ? await defaultDeps() : {}), ...overrides };
    const env = typeof deps.env === "function" ? deps.env() : process.env;
    const swingCfg = getSwingConfig(env);
    const n = clampDays(req.query?.days);
    const emptyTally = tallyOutcomes([]);
    if (!swingCfg.enabled) {
      return res.status(200).json({ ok: true, enabled: false, shadow: true, asOf: null, outlook: null, days: [], pastOutlooks: [], tally: emptyTally });
    }
    try {
      const today = istOf(deps.now()).date;
      const dates = lastDates(today, n).filter((d) => getSessionKindForDate(d) !== "CLOSED");
      const { days, outlooks } = await loadSwingHistory({ mget: deps.mget, dates, includeOutlooks: true });
      // Volume profiles for the invalidation ladder: summaries captured before 19-Nov-2026 carry
      // none, so derive them (on read, never written) from that day's scorecard minute series.
      const needVp = days.filter((d) => !d.volProfile);
      if (needVp.length) {
        try {
          const docs = (await deps.mget(needVp.map((d) => scKeys.day(d.date)))) || [];
          needVp.forEach((d, i) => {
            const doc = docs[i];
            if (doc && doc.date === d.date && doc.series) d.volProfile = profileFromSeries(doc.series);
          });
        } catch (e) { /* ladder works without volume levels */ }
      }
      const outlook = computeWeeklyOutlook({ days, config: getOutlookConfig(env) });
      const setupCfg = getSetupConfig(env);
      const outcomeOf = (o, date, k) => evaluateSetupOutcome({ setup: o.setups?.[k], asOf: o.asOf || date, laterDays: days, cfg: setupCfg });
      const pastOutlooks = outlooks.map(({ date, outlook: o }) => ({
        date,
        regime: o.regime,
        confidence: o.confidence ?? null,
        headline: o.headline ?? null,
        reference: o.reference ?? null,
        expectedRange: o.expectedRange ?? null,
        horizon: o.horizon ?? null,
        outcome: evaluateOutlookOutcome({ outlook: { ...o, asOf: o.asOf || date }, laterDays: days }),
        // v2 snapshots carry option setups (src/outlookSetups.js); older ones have none.
        setups: o.setups ? { call: o.setups.call || null, put: o.setups.put || null, setupExpiry: o.setups.setupExpiry || null } : null,
        setupOutcomes: o.setups ? { call: outcomeOf(o, date, "call"), put: outcomeOf(o, date, "put") } : null,
      }));
      return res.status(200).json({
        ok: true,
        enabled: true,
        shadow: true,
        note: "Shadow outlook: display and measurement only. No orders, no Telegram, not part of the scorecard sections.",
        asOf: outlook.asOf,
        daysRequested: n,
        outlook,
        days: days.map(compactDay),
        pastOutlooks,
        tally: { ...tallyOutcomes(pastOutlooks), setups: tallySetups(pastOutlooks) },
        rules: { hit: OUTLOOK_HIT_RULES, horizon: OUTLOOK_HORIZON_RULE },
      });
    } catch (e) {
      return res.status(200).json({ ok: false, enabled: true, error: String(e?.message || e), asOf: null, outlook: null, days: [], pastOutlooks: [], tally: emptyTally });
    }
  };
}

export default createSwingHandler();
