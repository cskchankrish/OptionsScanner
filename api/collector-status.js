/**
 * Collector status: GET /api/collector-status
 *
 * Diagnose a poller outage without logging in to Upstash.
 *  - Public (no secret): coarse summary only —
 *      { state, snapshotAgeSec, lastTickTime, ticksToday, expectedTicks, coveragePct, maxGapMin,
 *        gaps: [{ from, to, minutes }] (gaps ≥ 3 min), lastOkBySource: { <source>: ageSec|null } }
 *  - Authenticated (webhook secret via authorizeRequest): also the last 100 poll failures (time,
 *    source, HTTP status returned, stage, error text, duration), the last 100 successes' timings,
 *    per-source last success / failure records, the poller heartbeat and the poller-down flag.
 * Coverage is recomputed NOW from the latest snapshot's timeline, so an ongoing outage shows as an
 * open gap ("to": "now"). Read-only: no NSE call, no Telegram, no writes.
 */
import { authorizeRequest, extractRequestSecret } from "../src/webhookAuth.js";
import { computeDataQuality } from "../src/dataQuality.js";
import { POLLER_DOWN_KEY } from "../src/collectorAlerts.js";

const SOURCES = ["vm", "qstash", "github-actions", "secret"];
const HEARTBEAT_KEY = "nifty:poller:last_ok";
const FAILURES_KEY = "nifty:poller:failures";
const SUCCESSES_KEY = "nifty:poller:successes";
const okKey = (s) => `nifty:poller:src_ok:${s}`;
const failKey = (s) => `nifty:poller:src_fail:${s}`;

/** IST calendar parts of an epoch ms. */
export function istParts(ms) {
  const d = new Date(ms + 330 * 60000);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

async function defaultDeps() {
  const { redisRestGet, redisRestCommand } = await import("./nifty-oi.js");
  return {
    now: () => Date.now(),
    get: (k) => redisRestGet(k),
    lrange: async (k, n) => {
      const r = await redisRestCommand(["LRANGE", k, "0", String(n - 1)]);
      return (Array.isArray(r) ? r : []).map((x) => { try { return JSON.parse(x); } catch (e) { return x; } });
    },
  };
}

/** Live session by IST clock: Mon–Fri 09:15–15:40, Sunday (Muhurat) 14:00–16:00. */
function isLiveAt(p) {
  if (p.dow === 0) return p.minutes >= 840 && p.minutes <= 960;
  if (p.dow === 6) return false;
  return p.minutes >= 555 && p.minutes <= 940;
}

export function createCollectorStatusHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed. Use GET." });

    const deps = { ...(await defaultDeps()), ...overrides };
    const presented = extractRequestSecret(req) !== null;
    const auth = presented ? authorizeRequest(req) : { ok: false };
    if (presented && !auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const authed = auth.ok === true;

    const nowMs = deps.now();
    const now = istParts(nowMs);
    const isLive = isLiveAt(now);
    let snap = null;
    try { snap = await deps.get("nifty:flow:latest"); } catch (e) { snap = null; }
    const snapAt = Number(snap?.snapshotAt);
    const snapshotAgeSec = Number.isFinite(snapAt) && snapAt > 0 ? Math.max(0, Math.round((nowMs - snapAt) / 1000)) : null;
    // Only today's ticks count: a snapshot from an earlier session says nothing about today.
    const sameDay = Number.isFinite(snapAt) && istParts(snapAt).date === now.date;
    const timeline = sameDay && Array.isArray(snap?.intradayTimeline) ? snap.intradayTimeline : [];
    const dq = computeDataQuality({ timeline, nowMins: now.minutes, isSunday: now.dow === 0, isLive, snapshotAgeSec });

    const sourceOk = {};
    const sourceFail = {};
    for (const s of SOURCES) {
      try { sourceOk[s] = await deps.get(okKey(s)); } catch (e) { sourceOk[s] = null; }
      if (authed) { try { sourceFail[s] = await deps.get(failKey(s)); } catch (e) { sourceFail[s] = null; } }
    }
    const ageOf = (rec) => {
      const t = rec?.at ? Date.parse(rec.at) : NaN;
      return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null;
    };
    const lastOkBySource = Object.fromEntries(SOURCES.map((s) => [s, ageOf(sourceOk[s])]));

    const body = {
      state: dq.state,
      snapshotAgeSec,
      lastTickTime: dq.lastTickTime,
      ticksToday: dq.ticksToday,
      expectedTicks: dq.expectedTicks,
      coveragePct: dq.coveragePct,
      maxGapMin: dq.maxGapMin,
      gaps: dq.gaps.map((g) => ({ from: g.from, to: g.to, minutes: g.minutes })),
      lastOkBySource,
    };
    if (authed) {
      let failures = [];
      let successes = [];
      let heartbeat = null;
      let pollerDown = null;
      try { failures = await deps.lrange(FAILURES_KEY, 100); } catch (e) { failures = []; }
      try { successes = await deps.lrange(SUCCESSES_KEY, 100); } catch (e) { successes = []; }
      try { heartbeat = await deps.get(HEARTBEAT_KEY); } catch (e) { heartbeat = null; }
      try { pollerDown = await deps.get(POLLER_DOWN_KEY); } catch (e) { pollerDown = null; }
      body.detail = {
        isLiveSession: isLive,
        istNow: `${now.date} ${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}`,
        snapshotAt: Number.isFinite(snapAt) ? new Date(snapAt).toISOString() : null,
        snapshotSource: snap?.snapshotSource ?? null,
        summary: dq.summary,
        heartbeat,
        pollerDown,
        sources: Object.fromEntries(SOURCES.map((s) => [s, { lastOk: sourceOk[s], lastFailure: sourceFail[s] }])),
        failures,
        successes: successes.map((x) => ({ at: x?.at, source: x?.source, status: x?.status, durationMs: x?.durationMs, ageSec: x?.ageSec ?? null })),
      };
    }
    return res.status(200).json(body);
  };
}

export default createCollectorStatusHandler();
