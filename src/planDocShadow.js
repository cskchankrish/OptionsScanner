/**
 * Plan document (Gemini weekly plan in a Google Doc) — SHADOW MEASUREMENT ONLY.
 *
 * Before the open, the poller stores a verbatim snapshot of today's entry of the plan document
 * (api/argon.js parses the document). At the first live poll of the day the snapshot's half-day
 * calls are appended to the scorecard as PLAN_DOC events, and the scorecard measures each window on
 * NIFTY futures. Later edits to the document are deliberately ignored: only the snapshot is scored.
 *
 * Nothing here feeds a decision, order, veto, EOD score or Telegram message.
 * See docs/plan-doc-shadow.md.
 *
 * Pure functions plus two small DI'd orchestration helpers (store adapter: get, setNx, del).
 */
import { hhmm } from "./dataQuality.js";
import { istParts, getSessionKindForDate, dowOfIsoDate } from "./marketCalendar.js";

export const PLAN_DOC_BAND_PCT = 0.15;
export const PLAN_DOC_OPEN_MINS = 555; // 09:15
export const PLAN_DOC_CLOSE_MINS = 930; // 15:30
export const PLAN_DOC_LAST_PREOPEN_MINS = 554; // 09:14
export const PLAN_DOC_EDGE_TOLERANCE_MIN = 5;
export const PLAN_DOC_DEFAULT_WINDOWS = Object.freeze({
  FIRST: Object.freeze({ startMins: 555, endMins: 720 }), // 09:15–12:00
  SECOND: Object.freeze({ startMins: 750, endMins: 930 }), // 12:30–15:30
  FULL: Object.freeze({ startMins: 555, endMins: 930 }), // 09:15–15:30
});
export const PLAN_DOC_LOCK_TTL_SEC = 20 * 3600;
export const PLAN_DOC_SNAP_TTL_SEC = 400 * 86400;
export const PLAN_DOC_FETCH_TIMEOUT_MS = 8000;
export const PLAN_DOC_ENV_KEYS = ["PLAN_DOC_SHADOW_ENABLED", "PLAN_DOC_BAND_PCT", "PLAN_DOC_SNAPSHOT_START"];

export const planKeys = {
  snap: (d) => `nifty:plan:snap:${d}`,
  snapLock: (d) => `nifty:plan:snap_lock:${d}`,
  eventsLock: (d) => `nifty:plan:events_lock:${d}`,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────────────────────
function parseHhmm(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/** PLAN_DOC_SHADOW_ENABLED (default on), PLAN_DOC_BAND_PCT (0.15), PLAN_DOC_SNAPSHOT_START ("08:45"). */
export function getPlanDocConfig(env = process.env) {
  const e = env || {};
  const enabledRaw = String(e.PLAN_DOC_SHADOW_ENABLED ?? "true").trim().toLowerCase();
  const band = Number(e.PLAN_DOC_BAND_PCT);
  const start = parseHhmm(e.PLAN_DOC_SNAPSHOT_START);
  const startMins = start !== null && start <= PLAN_DOC_LAST_PREOPEN_MINS ? start : parseHhmm("08:45");
  return {
    enabled: enabledRaw !== "false" && enabledRaw !== "0" && enabledRaw !== "off",
    bandPct: Number.isFinite(band) && band > 0 ? band : PLAN_DOC_BAND_PCT,
    snapshotStart: hhmm(startMins),
    snapshotStartMins: startMins,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parsing (pure). Keyword entries are case-insensitive regex fragments matched at the START of a
//  word (so "BOUNCE" also matches "BOUNCES", "FALL" also matches "FALLBACK").
// ─────────────────────────────────────────────────────────────────────────────
export const PLAN_BULLISH_KEYWORDS = Object.freeze([
  "BOUNCE", "RALLY", "RALLIES", "RECOVER", "STABILI", "TURN SETUP", "BREAKOUT", "BUY", "UPSIDE", "REVERSAL UP", "UPTREND",
]);
export const PLAN_BEARISH_KEYWORDS = Object.freeze([
  "REJECT", "SELL-OFF", "SELLOFF", "SELL", "FLUSH", "BREAKDOWN", "DOWNSIDE", "STRESS", "FALL", "TEST OF S\\d", "CRASH", "DOWNTREND",
]);
export const PLAN_RANGE_KEYWORDS = Object.freeze([
  "PINNING", "PINNED", "TWO-WAY", "TWO WAY", "RANGE", "CHOP", "WHIPSAW", "SIDEWAYS", "CONSOLIDAT",
]);
/** A phrase containing any of these is never scored (direction ambiguous by construction). */
export const PLAN_AMBIGUOUS_KEYWORDS = Object.freeze(["TRAP"]);

const kwRe = (k) => new RegExp(`(?<![A-Z0-9])${k}`, "i");
const matching = (text, list) => list.filter((k) => kwRe(k).test(text));

const FIRST_TAG_RE = /(?<![A-Z0-9])(?:1ST|FIRST)[\s-]*HALF\b/i;
const SECOND_TAG_RE = /(?<![A-Z0-9])(?:2ND|SECOND)[\s-]*HALF\b/i;

/** Classifies one phrase: { call: BULLISH|BEARISH|RANGE|UNPARSED, reason }. Never guesses. */
export function classifyPlanPhrase(phrase) {
  const text = String(phrase || "").replace(FIRST_TAG_RE, " ").replace(SECOND_TAG_RE, " ").replace(/\s+/g, " ").trim();
  if (!text) return { call: "UNPARSED", reason: "empty phrase" };
  const amb = matching(text, PLAN_AMBIGUOUS_KEYWORDS);
  if (amb.length) return { call: "UNPARSED", reason: `contains ${amb.join(", ")} (direction ambiguous)` };
  const fam = {
    BULLISH: matching(text, PLAN_BULLISH_KEYWORDS),
    BEARISH: matching(text, PLAN_BEARISH_KEYWORDS),
    RANGE: matching(text, PLAN_RANGE_KEYWORDS),
  };
  const hit = Object.entries(fam).filter(([, v]) => v.length);
  if (!hit.length) return { call: "UNPARSED", reason: "no known keyword" };
  const show = (v) => v.map((k) => k.replace("\\d", "<digit>")).join(", ");
  if (hit.length > 1) return { call: "UNPARSED", reason: `mixed keyword families: ${hit.map(([f, v]) => `${f} (${show(v)})`).join(" + ")}` };
  return { call: hit[0][0], reason: `matched ${show(hit[0][1])}` };
}

/** Conviction from "(Conviction: HIGH)" etc., or null. */
export function parseConviction(stance) {
  const m = /\(\s*Conviction\s*:\s*(HIGHEST|HIGH|MEDIUM|LOW)\b/i.exec(String(stance || ""));
  return m ? m[1].toUpperCase() : null;
}

const clampMins = (v) => Math.min(PLAN_DOC_CLOSE_MINS, Math.max(PLAN_DOC_OPEN_MINS, v));

/** Window of one half from the forecast ("1st Half (09:15–12:00 IST)"), clamped, else the default. */
export function parseHalfWindow(forecast, half) {
  const def = PLAN_DOC_DEFAULT_WINDOWS[half] || PLAN_DOC_DEFAULT_WINDOWS.FULL;
  if (half === "FULL") return { ...def, fromForecast: false };
  const tag = half === "FIRST" ? "(?:1st|first)" : "(?:2nd|second)";
  const re = new RegExp(`${tag}[\\s-]*half\\s*\\(\\s*(\\d{1,2}):(\\d{2})\\s*[–\\-—]\\s*(\\d{1,2}):(\\d{2})`, "i");
  const m = re.exec(String(forecast || ""));
  if (!m) return { ...def, fromForecast: false };
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  if (!(Number(m[2]) < 60 && Number(m[4]) < 60)) return { ...def, fromForecast: false };
  const startMins = clampMins(a);
  const endMins = clampMins(b);
  if (!(endMins > startMins)) return { ...def, fromForecast: false };
  return { startMins, endMins, fromForecast: true };
}

/**
 * Half-day calls of one plan-document session.
 * @returns {{ conviction, calls: [{ half, phrase, call, reason, startMins, endMins }] }}
 */
export function parsePlanCalls(session) {
  const stance = String(session?.stance || "");
  const conviction = parseConviction(stance);
  const head = stance.split(/\(\s*Conviction\s*:/i)[0];
  const phrases = head.split("·").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const tagOf = (p) => (FIRST_TAG_RE.test(p) ? "FIRST" : SECOND_TAG_RE.test(p) ? "SECOND" : null);
  const anyTagged = phrases.some((p) => tagOf(p));

  // [{ half, phrase }] — at most one entry per half.
  let parts = [];
  if (!phrases.length) {
    parts = [];
  } else if (anyTagged) {
    // An untagged phrase continues the preceding one (or the next one when it comes first); two
    // phrases with the same tag are joined. A joined phrase is classified as a whole (conservative).
    const byHalf = { FIRST: [], SECOND: [] };
    let current = null;
    const pending = [];
    for (const p of phrases) {
      const t = tagOf(p);
      if (FIRST_TAG_RE.test(p) && SECOND_TAG_RE.test(p)) { current = null; pending.push(p); continue; }
      if (t) {
        current = t;
        byHalf[t].push(...pending.splice(0), p);
      } else if (current) {
        byHalf[current].push(p);
      } else {
        pending.push(p);
      }
    }
    if (pending.length) {
      // Phrases that could not be attached (e.g. a phrase tagged with both halves): never guessed.
      parts.push({ half: "FULL", phrase: pending.join(" · "), forceUnparsed: "phrase could not be attached to one half" });
    }
    for (const h of ["FIRST", "SECOND"]) if (byHalf[h].length) parts.push({ half: h, phrase: byHalf[h].join(" · ") });
  } else if (phrases.length === 2) {
    parts = [{ half: "FIRST", phrase: phrases[0] }, { half: "SECOND", phrase: phrases[1] }];
  } else {
    parts = [{ half: "FULL", phrase: phrases.join(" · ") }];
  }

  const forecast = session?.forecast || "";
  const calls = parts.map(({ half, phrase, forceUnparsed }) => {
    const c = forceUnparsed ? { call: "UNPARSED", reason: forceUnparsed } : classifyPlanPhrase(phrase);
    const w = parseHalfWindow(forecast, half);
    return { half, phrase, call: c.call, reason: c.reason, startMins: w.startMins, endMins: w.endMins };
  });
  return { conviction, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Session for a date (pure)
// ─────────────────────────────────────────────────────────────────────────────
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * The session whose `date` ("16 Nov") AND weekday match the IST ISO date; null when the document
 * does not cover that date (or covers it ambiguously). Never falls back to the closest day.
 */
export function findSessionForDate(sessions, isoDate) {
  if (!Array.isArray(sessions)) return null;
  const dow = dowOfIsoDate(isoDate);
  if (dow === null) return null;
  const [, mm, dd] = isoDate.split("-").map(Number);
  const matches = sessions.filter((s) => {
    const m = /^\s*(\d{1,2})\s+([A-Za-z]{3})/.exec(String(s?.date || ""));
    if (!m) return false;
    if (Number(m[1]) !== dd || MONTHS.indexOf(m[2].toLowerCase()) + 1 !== mm) return false;
    return String(s?.day || "").trim().toLowerCase() === DAY_NAMES[dow];
  });
  return matches.length === 1 ? matches[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Snapshot (pure)
// ─────────────────────────────────────────────────────────────────────────────
export function buildPlanSnapshot({ isoDate, session, fetchedAtMs, source, late = false, cacheUpdatedAt = null }) {
  const s = session || {};
  return {
    v: 1,
    date: isoDate,
    fetchedAt: new Date(Number(fetchedAtMs) || 0).toISOString(),
    source: source === "redis_cache" ? "redis_cache" : "google_doc_live",
    late: Boolean(late),
    ...(cacheUpdatedAt ? { cacheUpdatedAt } : {}),
    raw: {
      stance: s.stance ?? null,
      forecast: s.forecast ?? null,
      action: s.action ?? null,
      sectors: s.sectors ?? null,
      sessionTitle: s.session ?? s.label ?? null,
      day: s.day ?? null,
      docDate: s.date ?? null,
    },
    parsed: parsePlanCalls(s),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Measurement (pure). series = scorecard compact series { m: minutes[], f: futures[] }.
// ─────────────────────────────────────────────────────────────────────────────
const HIT_OUTCOME = { BULLISH: "UP", BEARISH: "DOWN", RANGE: "FLAT" };

export function measurePlanCall(call, series, cfg = {}) {
  const bandPct = Number(cfg?.bandPct) > 0 ? Number(cfg.bandPct) : PLAN_DOC_BAND_PCT;
  const start = Number(call?.startMins);
  const end = Number(call?.endMins);
  const scored = Object.prototype.hasOwnProperty.call(HIT_OUTCOME, call?.call);
  const unscored = (extra) => ({ status: "NOT_SCORED", reason: `call ${call?.call || "missing"}: not scored`, hit: null, ...extra });
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    return scored ? { status: "UNMEASURABLE", reason: "invalid window" } : unscored({});
  }
  const ticks = [];
  const m = series?.m || [];
  for (let i = 0; i < m.length; i++) {
    const p = Number(series.f?.[i]);
    if (p > 0 && Number.isFinite(Number(m[i]))) ticks.push({ minutes: Number(m[i]), price: p });
  }
  ticks.sort((a, b) => a.minutes - b.minutes);
  const tol = PLAN_DOC_EDGE_TOLERANCE_MIN;
  const ref = ticks.find((t) => t.minutes >= start && t.minutes <= start + tol);
  let fin = null;
  for (const t of ticks) if (t.minutes <= end && t.minutes >= end - tol) fin = t;
  let problem = null;
  if (!ref) problem = `no futures tick within ${tol} min after the window start ${hhmm(start)}`;
  else if (!fin) problem = `no futures tick within ${tol} min before the window end ${hhmm(end)}${ticks.length && ticks[ticks.length - 1].minutes < end - tol ? " (window not over yet, or a data gap)" : ""}`;
  else if (!(fin.minutes > ref.minutes)) problem = "window has no span between its first and last tick";
  if (problem) return scored ? { status: "UNMEASURABLE", reason: problem } : unscored({});
  const movePct = Math.round(((fin.price - ref.price) / ref.price) * 100 * 10000) / 10000;
  const outcome = movePct >= bandPct ? "UP" : movePct <= -bandPct ? "DOWN" : "FLAT";
  const base = {
    refPrice: ref.price, refAt: hhmm(ref.minutes), endPrice: fin.price, endAt: hhmm(fin.minutes),
    movePct, movePts: Math.round((fin.price - ref.price) * 100) / 100, outcome, bandPct,
  };
  if (!scored) return unscored(base);
  return { status: "MEASURED", ...base, hit: outcome === HIT_OUTCOME[call.call] };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Orchestration (DI; never throws)
// ─────────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label = "timeout") {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label)), ms); }),
  ]);
}

/**
 * Pre-open snapshot (MARKET_CLOSED branch of api/poll.js).
 * deps: { store: {get,setNx,del}, fetchLiveSessions(): sessions[]|null, env?, fetchTimeoutMs? }
 * @returns {{ status: "DISABLED"|"NOT_SESSION_DAY"|"OUTSIDE_WINDOW"|"ALREADY_CLAIMED"|"TAKEN"|"RETRY"|"NO_ENTRY", reason? }}
 */
export async function takePreOpenPlanSnapshot({ nowMs, store, fetchLiveSessions, env = process.env, fetchTimeoutMs = PLAN_DOC_FETCH_TIMEOUT_MS }) {
  const cfg = getPlanDocConfig(env);
  if (!cfg.enabled || !store) return { status: "DISABLED" };
  const p = istParts(nowMs);
  if (getSessionKindForDate(p.date) !== "WEEKDAY") return { status: "NOT_SESSION_DAY" };
  if (p.minutes < cfg.snapshotStartMins || p.minutes > PLAN_DOC_LAST_PREOPEN_MINS) return { status: "OUTSIDE_WINDOW" };
  let claimed = false;
  const release = async () => { try { await store.del(planKeys.snapLock(p.date)); } catch (e) { /* lock expires anyway */ } };
  try {
    claimed = Boolean(await store.setNx(planKeys.snapLock(p.date), { at: new Date(nowMs).toISOString() }, PLAN_DOC_LOCK_TTL_SEC));
    if (!claimed) return { status: "ALREADY_CLAIMED" };
    let sessions = null;
    try {
      sessions = await withTimeout(fetchLiveSessions(), fetchTimeoutMs, `plan document fetch exceeded ${fetchTimeoutMs} ms`);
    } catch (e) {
      sessions = null;
    }
    if (!Array.isArray(sessions) || !sessions.length) {
      await release();
      return { status: "RETRY", reason: "plan document fetch failed or returned no sessions" };
    }
    const session = findSessionForDate(sessions, p.date);
    if (!session) {
      await release();
      return { status: "NO_ENTRY", reason: `the document has no entry for ${p.date}` };
    }
    const snap = buildPlanSnapshot({ isoDate: p.date, session, fetchedAtMs: nowMs, source: "google_doc_live", late: false });
    const stored = await store.setNx(planKeys.snap(p.date), snap, PLAN_DOC_SNAP_TTL_SEC);
    return { status: "TAKEN", stored: Boolean(stored) };
  } catch (e) {
    if (claimed) await release();
    return { status: "RETRY", reason: e?.message || String(e) };
  }
}

/**
 * First live poll of the day: append one scorecard event per parsed call, exactly once.
 * deps: { store, getCachedSessions(): {sessions, updatedAt}|null, buildEvents(snapshot) → events[],
 *         recordEvent({store,date,event,env}), env? }
 */
export async function recordPlanEventsOnce({ nowMs, store, getCachedSessions, buildEvents, recordEvent, env = process.env }) {
  const cfg = getPlanDocConfig(env);
  if (!cfg.enabled || !store) return { status: "DISABLED" };
  const p = istParts(nowMs);
  if (getSessionKindForDate(p.date) !== "WEEKDAY") return { status: "NOT_SESSION_DAY" };
  let claimed = false;
  try {
    claimed = Boolean(await store.setNx(planKeys.eventsLock(p.date), { at: new Date(nowMs).toISOString() }, PLAN_DOC_LOCK_TTL_SEC));
    if (!claimed) return { status: "ALREADY_DONE" };
    let snap = await store.get(planKeys.snap(p.date));
    if (!snap || typeof snap !== "object" || !snap.parsed) {
      let cached = null;
      try { cached = await getCachedSessions(); } catch (e) { cached = null; }
      const session = findSessionForDate(cached?.sessions, p.date);
      if (!session) return { status: "NO_ENTRY", reason: `no snapshot and no cached entry for ${p.date}` };
      const late = buildPlanSnapshot({ isoDate: p.date, session, fetchedAtMs: nowMs, source: "redis_cache", late: true, cacheUpdatedAt: cached?.updatedAt || null });
      await store.setNx(planKeys.snap(p.date), late, PLAN_DOC_SNAP_TTL_SEC);
      const again = await store.get(planKeys.snap(p.date));
      snap = again && typeof again === "object" && again.parsed ? again : late;
    }
    const events = buildEvents(snap) || [];
    for (const event of events) await recordEvent({ store, date: p.date, event, env });
    return { status: "RECORDED", events: events.length, late: Boolean(snap.late) };
  } catch (e) {
    // Let a later poll retry (event ids are deduplicated by the scorecard).
    if (claimed) { try { await store.del(planKeys.eventsLock(p.date)); } catch (e2) { /* ignore */ } }
    return { status: "ERROR", reason: e?.message || String(e) };
  }
}
