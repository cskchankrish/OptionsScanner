/**
 * GET /api/scorecard
 *   ?date=YYYY-MM-DD   one day in full detail (finalises the day lazily and idempotently when the
 *                      session is over and nothing finalised it at 15:38)
 *   ?days=30           rolling aggregate per section (1–180), Wilson 95% intervals, "too few to judge"
 *   &format=csv        CSV of either
 *   POST {action:"backfill", day:{...}} (authenticated) — writes one prepared backfilled day document
 *                      (produced by scripts/backfill-scorecard.mjs). Never automatic.
 *
 * Public: panel statistics and events. Authenticated (webhook secret): also rupee trade results and
 * the settings snapshot. Measurement only — no NSE call, no decision touched.
 */
import { authorizeRequest, extractRequestSecret } from "../src/webhookAuth.js";
import { computeDataQuality } from "../src/dataQuality.js";
import {
  keys, finaliseDay, aggregate, publicDayView, dayToCsv, aggregateToCsv, istOf, timelineKeysFor,
  scStoreFromCommand, measureEvent, compactSeries, finalEodEvent, getScorecardConfig, SC_CLOSE_MEASURE_MINS, SC_TTL_SEC,
} from "../src/scorecard.js";

async function defaultDeps() {
  const { redisRestCommand, scorecardSettings } = await import("./nifty-oi.js");
  const { sendTelegramText } = await import("./tv-webhook.js");
  const store = scStoreFromCommand(redisRestCommand);
  return {
    now: () => Date.now(),
    store,
    getTimeline: async (date) => {
      for (const k of timelineKeysFor(date)) {
        const t = await store.get(k);
        if (Array.isArray(t) && t.length) return t;
      }
      return [];
    },
    settings: () => scorecardSettings(),
    send: sendTelegramText,
  };
}

const isoOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));

function shiftDate(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function createScorecardHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(200).end();
    let body = null;
    try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch (e) { body = null; }
    const presented = extractRequestSecret(req, body) !== null;
    const auth = presented ? authorizeRequest(req, body) : { ok: false };
    if (presented && !auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const authed = auth.ok === true;
    const deps = { ...(await defaultDeps()), ...overrides };
    const store = deps.store;
    const nowMs = deps.now();
    const today = istOf(nowMs);

    if (req.method === "POST") {
      if (!authed) return res.status(401).json({ ok: false, error: "Unauthorized" });
      if (body?.action !== "backfill" || !body.day || !isoOk(body.day.date) || body.day.backfilled !== true) {
        return res.status(400).json({ ok: false, error: "expected { action: 'backfill', day: <document with backfilled: true> }" });
      }
      const existing = await store.get(keys.day(body.day.date));
      if (existing && !existing.backfilled && !body.overwrite) {
        return res.status(409).json({ ok: false, error: "a live-recorded day exists for this date; not overwritten" });
      }
      await store.set(keys.day(body.day.date), body.day, SC_TTL_SEC);
      return res.status(200).json({ ok: true, written: body.day.date });
    }
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    const csv = String(req.query?.format || "") === "csv";

    // ── one day ──
    if (req.query?.date !== undefined) {
      const date = String(req.query.date);
      if (!isoOk(date)) return res.status(400).json({ ok: false, error: "date must be YYYY-MM-DD" });
      let doc = await store.get(keys.day(date));
      const over = date < today.date || (date === today.date && today.minutes >= SC_CLOSE_MEASURE_MINS);
      if (!doc?.finalisedAt && over) {
        const r = await finaliseDay({
          store, date,
          deps: {
            getTimeline: deps.getTimeline,
            computeDataQuality: (tl) => computeDataQuality({ timeline: tl, nowMins: 940, isSunday: false, isLive: false }),
            settings: deps.settings(),
            send: deps.send,
            now: deps.now,
          },
        });
        doc = r.doc || doc;
      }
      if (!doc) {
        // Today, still live: provisional outcomes on the timeline so far.
        const events = ((await store.lrange(keys.events(date), 0, -1)) || []).filter((e) => e && e.id);
        const state = await store.get(keys.state(date));
        const timeline = await deps.getTimeline(date);
        const series = compactSeries(timeline);
        const cfg = getScorecardConfig();
        doc = {
          v: 1, date, provisional: true, finalisedAt: null, events,
          outcomes: Object.fromEntries(events.map((e) => [e.id, measureEvent(e, series, cfg)])),
          eodFinal: finalEodEvent(state), eodOutcome: null,
          dataQuality: timeline.length ? (() => { const { _gapMins, ...dq } = computeDataQuality({ timeline, nowMins: today.minutes, isLive: true }); return dq; })() : null,
        };
      }
      const view = authed ? doc : publicDayView(doc);
      if (csv) {
        res.setHeader("Content-Type", "text/csv");
        return res.status(200).send(dayToCsv(view, { authed }));
      }
      const { series, ...light } = view;
      return res.status(200).json({ ok: true, authenticated: authed, ...light, seriesPoints: series?.m?.length ?? null, ...(req.query?.series === "1" ? { series } : {}) });
    }

    // ── rolling aggregate ──
    const n = Math.max(1, Math.min(180, Math.round(Number(req.query?.days) || 30)));
    const dates = [];
    for (let i = 0; i < n; i++) dates.push(shiftDate(today.date, -i));
    let docs = [];
    try {
      docs = (await store.mget(dates.map((d) => keys.day(d)))).filter((d) => d && d.date);
    } catch (e) {
      docs = [];
    }
    const agg = aggregate(docs, { minSample: getScorecardConfig().minSample, includeTrades: authed });
    agg.days = n;
    agg.datesWithData = docs.map((d) => ({ date: d.date, backfilled: Boolean(d.backfilled), coveragePct: d.dataQuality?.coveragePct ?? null }));
    if (csv) {
      res.setHeader("Content-Type", "text/csv");
      return res.status(200).send(aggregateToCsv(agg));
    }
    return res.status(200).json({ ok: true, authenticated: authed, ...agg });
  };
}

export default createScorecardHandler();
