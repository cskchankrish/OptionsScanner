/**
 * GET /api/carry-check?days=30   Carry check (SHADOW — measurement only).
 *
 * For each recorded session: the candidate "hold overnight?" metrics as they stood at the close,
 * what the next session did versus that day's 15:36 square-off price, and how each metric's vote
 * scored; plus a per-metric summary. Public and read-only: no writes, no NSE call, no Telegram,
 * nothing read by any decision, the Algo or the carry bridge. See src/carryCheck.js.
 */
import { loadSwingHistory, lastDates, getSwingConfig } from "../src/swingSummary.js";
import { keys, istOf, compactSeries, isSessionDayDoc, timelineKeysFor } from "../src/scorecard.js";
import { getSessionKindForDate } from "../src/marketCalendar.js";
import { buildCarryRows, summariseCarry, CARRY_CHECK_DEFAULTS, CARRY_METRICS } from "../src/carryCheck.js";

export const CARRY_API_DEFAULT_DAYS = 30;
export const CARRY_API_MAX_DAYS = 120;

async function defaultDeps() {
  const { redisRestCommand } = await import("./nifty-oi.js");
  const { scStoreFromCommand } = await import("../src/scorecard.js");
  const store = scStoreFromCommand(redisRestCommand);
  return {
    now: () => Date.now(),
    mget: (ks) => store.mget(ks),
    getTimeline: async (date) => {
      for (const k of timelineKeysFor(date)) {
        const t = await store.get(k);
        if (Array.isArray(t) && t.length) return t;
      }
      return [];
    },
    env: () => process.env,
  };
}

export function clampCarryDays(raw) {
  const n = Math.round(Number(raw));
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) return CARRY_API_DEFAULT_DAYS;
  return Math.max(2, Math.min(CARRY_API_MAX_DAYS, n));
}

export function createCarryCheckHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed. Use GET." });
    const needDefaults = !overrides.mget || !overrides.now || !overrides.getTimeline;
    const deps = { ...(needDefaults ? await defaultDeps() : {}), ...overrides };
    const env = typeof deps.env === "function" ? deps.env() : process.env;
    const n = clampCarryDays(req.query?.days);
    try {
      const today = istOf(deps.now()).date;
      const dates = lastDates(today, n).filter((d) => getSessionKindForDate(d) !== "CLOSED").sort();
      const swingEnabled = getSwingConfig(env).enabled;
      const { days, outlooks } = swingEnabled
        ? await loadSwingHistory({ mget: deps.mget, dates, includeOutlooks: true })
        : { days: [], outlooks: [] };
      let docs = [];
      try {
        docs = (await deps.mget(dates.map((d) => keys.day(d)))) || [];
      } catch (e) {
        docs = [];
      }
      const scDocs = {};
      dates.forEach((d, i) => {
        const doc = docs[i];
        if (doc && doc.date === d && isSessionDayDoc(doc)) scDocs[d] = doc;
      });
      // Today is not finalised until 15:38: its live timeline serves as the "next session" for
      // yesterday, so yesterday's outcome appears from 10:30 today.
      if (!scDocs[today] && getSessionKindForDate(today) !== "CLOSED") {
        try {
          const tl = await deps.getTimeline(today);
          if (Array.isArray(tl) && tl.length) scDocs[today] = { date: today, series: compactSeries(tl), futuresExpiry: null, live: true };
        } catch (e) { /* no live series: yesterday stays PENDING */ }
      }
      const outlookByDate = Object.fromEntries(outlooks.map(({ date, outlook }) => [date, outlook]));
      const rows = buildCarryRows({ swingDays: days, scDocs, outlooks: outlookByDate });
      return res.status(200).json({
        ok: true,
        shadow: true,
        note: "Measurement only: what holding overnight in each metric's direction would have done versus exiting at the 15:36 square-off. Not a recommendation; nothing here changes a decision or an order.",
        hitRule: "Holding in the voted direction was ahead of the 15:36 exit at 10:30 next session (futures).",
        majorMove: `A move of at least ${CARRY_CHECK_DEFAULTS.majorPct}% in a direction before 11:00 next session.`,
        config: CARRY_CHECK_DEFAULTS,
        metrics: CARRY_METRICS.map(([id, label]) => ({ id, label })),
        daysRequested: n,
        summary: summariseCarry(rows),
        sessions: rows.slice().reverse(),
      });
    } catch (e) {
      return res.status(200).json({ ok: false, shadow: true, error: String(e?.message || e), summary: null, sessions: [] });
    }
  };
}

export default createCarryCheckHandler();
