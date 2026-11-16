/**
 * Plan-document shadow: parsing of the Gemini weekly plan, the pre-open snapshot, the first-live-poll
 * scorecard events and the PLAN_DOC scorecard section. All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "PLAN_DOC_SHADOW_ENABLED", "PLAN_DOC_BAND_PCT", "PLAN_DOC_SNAPSHOT_START",
]) delete process.env[k];

const pd = await import("../src/planDocShadow.js");
const sc = await import("../src/scorecard.js");
const { createPollHandler, resetPlanMemoForTesting } = await import("../api/poll.js");
const { getMarketSessionInfo } = await import("../api/nifty-oi.js");

const SECRET = "plan-doc-test-secret";
const ist = (date, hm) => {
  const [h, m] = hm.split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60000;
};

// ── Real sessions of the week of 16 Nov 2026 (stances verbatim; forecasts verbatim excerpts) ──
const MON = {
  day: "Monday", date: "16 Nov", label: "Monday · 16 Nov", session: "Monday, Nov 16",
  stance: "1ST-HALF BOUNCE TO SUPPLY · 2ND-HALF VYATIPATA REJECTION (Conviction: HIGH)",
  forecast: "1st Half (09:15–12:00 IST): GIFT Nifty (25,249) opens Nifty above Weekly Pivot (25,135.80) toward Friday's high ... 2nd Half (12:30–15:30 IST): Surya-Chandra Vyatipata at 12:34 IST and pre-Sankranti positioning cap the rally near 25,305–25,360 and pull spot back toward 25,136–24,983. ...",
  action: "Sell rallies into 25,305–25,360 after 12:30.", sectors: "SHELTER: FMCG",
};
const TUE = {
  day: "Tuesday", date: "17 Nov", label: "Tuesday · 17 Nov",
  stance: "TWO-WAY EXPIRY PINNING · LATE RAHU KAAL WHIPSAW (Conviction: HIGH)",
  forecast: "1st Half (09:15–13:00 IST): ... option writers pin Nifty between Cam S3 (24,983.26) and Cam R3 (25,305.34) ... 2nd Half (13:00–15:30 IST): ... triggers a sharp last-hour expiry move.",
  action: "", sectors: "",
};
const WED = {
  day: "Wednesday", date: "18 Nov", label: "Wednesday · 18 Nov",
  stance: "1ST-HALF TRAP BOUNCE · 2ND-HALF SUN-JUPITER SQUARE SELL-OFF (Conviction: HIGHEST)",
  forecast: "1st Half (09:15–12:05 IST): Morning attempt in Rahu-ruled Shatabhisha stalls below Weekly Cam R3 ... 2nd Half (12:06–15:30 IST): ... pressuring Banking and Financials toward the 24,983–24,847 support zone",
  action: "", sectors: "",
};
const THU = {
  day: "Thursday", date: "19 Nov", label: "Thursday · 19 Nov",
  stance: "PEAK STRESS WINDOW · TEST OF S1 / DOWNSIDE FALLBACK (Conviction: HIGHEST)",
  forecast: "1st Half (09:15–13:15 IST): ... tests Weekly Standard S1 (24,847.25) and Camarilla S4 (24,822.22). 2nd Half (13:31–15:30 IST): If 24,822 breaks on a 15-min close ...",
  action: "", sectors: "",
};
const FRI = {
  day: "Friday", date: "20 Nov", label: "Friday · 20 Nov",
  stance: "1ST-HALF FINAL FLUSH/TEST · 2ND-HALF STABILIZATION & TURN SETUP (Conviction: HIGH)",
  forecast: "1st Half (09:15–12:15 IST): ... 2nd Half (13:00–15:30 IST): ...",
  action: "", sectors: "",
};
const WEEK = [MON, TUE, WED, THU, FRI];
const brief = (p) => ({ conviction: p.conviction, calls: p.calls.map(({ half, call, startMins, endMins }) => ({ half, call, startMins, endMins })) });

// ─────────────────────────────────────────────────────────────────────────────
//  Parsing
// ─────────────────────────────────────────────────────────────────────────────
test("parsePlanCalls: the five real stances of 16–20 Nov", () => {
  assert.deepEqual(brief(pd.parsePlanCalls(MON)), { conviction: "HIGH", calls: [
    { half: "FIRST", call: "BULLISH", startMins: 555, endMins: 720 },
    { half: "SECOND", call: "BEARISH", startMins: 750, endMins: 930 },
  ] });
  assert.deepEqual(brief(pd.parsePlanCalls(TUE)), { conviction: "HIGH", calls: [
    { half: "FIRST", call: "RANGE", startMins: 555, endMins: 780 },
    { half: "SECOND", call: "RANGE", startMins: 780, endMins: 930 },
  ] });
  assert.deepEqual(brief(pd.parsePlanCalls(WED)), { conviction: "HIGHEST", calls: [
    { half: "FIRST", call: "UNPARSED", startMins: 555, endMins: 725 },
    { half: "SECOND", call: "BEARISH", startMins: 726, endMins: 930 },
  ] });
  assert.deepEqual(brief(pd.parsePlanCalls(THU)), { conviction: "HIGHEST", calls: [
    { half: "FIRST", call: "BEARISH", startMins: 555, endMins: 795 },
    { half: "SECOND", call: "BEARISH", startMins: 811, endMins: 930 },
  ] });
  assert.deepEqual(brief(pd.parsePlanCalls(FRI)), { conviction: "HIGH", calls: [
    { half: "FIRST", call: "BEARISH", startMins: 555, endMins: 735 },
    { half: "SECOND", call: "BULLISH", startMins: 780, endMins: 930 },
  ] });
  // Phrases are kept verbatim; TRAP is the reason for UNPARSED.
  const wed = pd.parsePlanCalls(WED).calls[0];
  assert.equal(wed.phrase, "1ST-HALF TRAP BOUNCE");
  assert.match(wed.reason, /TRAP/);
  assert.equal(pd.parsePlanCalls(TUE).calls[1].phrase, "LATE RAHU KAAL WHIPSAW");
});

test("classifyPlanPhrase: required phrase verdicts", () => {
  const c = (p) => pd.classifyPlanPhrase(p).call;
  assert.equal(c("1ST-HALF TRAP BOUNCE"), "UNPARSED");
  assert.equal(c("LATE RAHU KAAL WHIPSAW"), "RANGE");
  assert.equal(c("PEAK STRESS WINDOW"), "BEARISH");
  assert.equal(c("TEST OF S1 / DOWNSIDE FALLBACK"), "BEARISH");
  assert.equal(c("1ST-HALF FINAL FLUSH/TEST"), "BEARISH");
  assert.equal(c("2ND-HALF STABILIZATION & TURN SETUP"), "BULLISH");
  assert.equal(c("TEST OF S2"), "BEARISH");
  assert.equal(c("RETEST OF RESISTANCE"), "UNPARSED", "TEST without S<digit> is not a keyword");
  assert.equal(c("BULL TRAP"), "UNPARSED");
  assert.equal(c("ARRANGEMENT DAY"), "UNPARSED", "keywords match at a word start only");
});

test("parsePlanCalls: edge cases", () => {
  // No conviction.
  const noConv = pd.parsePlanCalls({ stance: "RALLY · SELL-OFF", forecast: "" });
  assert.equal(noConv.conviction, null);
  assert.deepEqual(noConv.calls.map((x) => [x.half, x.call]), [["FIRST", "BULLISH"], ["SECOND", "BEARISH"]]);
  // Unknown words → UNPARSED.
  const unk = pd.parsePlanCalls({ stance: "MERCURY RETROGRADE DRIFT (Conviction: LOW)" });
  assert.deepEqual(unk.calls.map((x) => [x.half, x.call]), [["FULL", "UNPARSED"]]);
  assert.equal(unk.conviction, "LOW");
  assert.match(unk.calls[0].reason, /no known keyword/);
  // Mixed families → UNPARSED.
  const mixed = pd.parsePlanCalls({ stance: "BOUNCE THEN SELL-OFF (Conviction: MEDIUM)" });
  assert.equal(mixed.calls[0].call, "UNPARSED");
  assert.match(mixed.calls[0].reason, /mixed/);
  assert.equal(pd.parsePlanCalls({ stance: "RANGE BREAKOUT" }).calls[0].call, "UNPARSED");
  // One phrase → FULL 09:15–15:30 (forecast windows ignored for FULL).
  const one = pd.parsePlanCalls({ stance: "SIDEWAYS CONSOLIDATION (Conviction: HIGH)", forecast: "1st Half (10:00–11:00 IST)" });
  assert.deepEqual(brief(one), { conviction: "HIGH", calls: [{ half: "FULL", call: "RANGE", startMins: 555, endMins: 930 }] });
  // Missing forecast windows → defaults.
  const def = pd.parsePlanCalls({ stance: "1ST-HALF RALLY · 2ND-HALF CHOP", forecast: "no times here" });
  assert.deepEqual(def.calls.map((x) => [x.startMins, x.endMins]), [[555, 720], [750, 930]]);
  // Window clamping to 09:15–15:30; hyphen and em-dash accepted.
  const cl = pd.parsePlanCalls({ stance: "1ST-HALF RALLY · 2ND-HALF CHOP", forecast: "1st Half (09:00-12:00 IST) ... 2nd Half (13:00—15:45 IST)" });
  assert.deepEqual(cl.calls.map((x) => [x.startMins, x.endMins]), [[555, 720], [780, 930]]);
  // A window entirely outside the session collapses → default.
  assert.deepEqual(pd.parseHalfWindow("2nd Half (16:00–17:00 IST)", "SECOND"), { startMins: 750, endMins: 930, fromForecast: false });
  // Tagged in reverse order still maps by tag.
  const rev = pd.parsePlanCalls({ stance: "SECOND HALF SELL · FIRST HALF RALLY" });
  assert.deepEqual(rev.calls.map((x) => [x.half, x.call]), [["FIRST", "BULLISH"], ["SECOND", "BEARISH"]]);
  // Untagged phrase after a tagged one continues it (and is classified with it).
  const cont = pd.parsePlanCalls({ stance: "1ST-HALF RALLY · FADE · 2ND-HALF CHOP" });
  assert.deepEqual(cont.calls.map((x) => [x.half, x.call, x.phrase]), [["FIRST", "BULLISH", "1ST-HALF RALLY · FADE"], ["SECOND", "RANGE", "2ND-HALF CHOP"]]);
  // Three untagged phrases → one FULL phrase, classified as a whole.
  assert.deepEqual(pd.parsePlanCalls({ stance: "RALLY · SELL · CHOP" }).calls.map((x) => [x.half, x.call]), [["FULL", "UNPARSED"]]);
  // Empty stance → no calls.
  assert.deepEqual(pd.parsePlanCalls({ stance: "" }), { conviction: null, calls: [] });
  assert.deepEqual(pd.parsePlanCalls(null), { conviction: null, calls: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
//  findSessionForDate
// ─────────────────────────────────────────────────────────────────────────────
test("findSessionForDate: exact date and weekday only, never the closest day", () => {
  assert.equal(pd.findSessionForDate(WEEK, "2026-11-16"), MON);
  assert.equal(pd.findSessionForDate(WEEK, "2026-11-19"), THU);
  // Last week's document (9–13 Nov) does not cover 16 Nov.
  const lastWeek = [
    { day: "Monday", date: "9 Nov" }, { day: "Tuesday", date: "10 Nov" }, { day: "Wednesday", date: "11 Nov" },
    { day: "Thursday", date: "12 Nov" }, { day: "Friday", date: "13 Nov" },
  ];
  assert.equal(pd.findSessionForDate(lastWeek, "2026-11-16"), null);
  // A gap in the document is not filled with a neighbour.
  assert.equal(pd.findSessionForDate([MON, TUE, THU, FRI], "2026-11-18"), null);
  // Weekday must match too (a "16 Nov" labelled Tuesday is a different year / wrong row).
  assert.equal(pd.findSessionForDate([{ ...MON, day: "Tuesday" }], "2026-11-16"), null);
  // Weekend / malformed / no sessions.
  assert.equal(pd.findSessionForDate(WEEK, "2026-11-21"), null);
  assert.equal(pd.findSessionForDate(WEEK, "bad"), null);
  assert.equal(pd.findSessionForDate(null, "2026-11-16"), null);
  assert.equal(pd.findSessionForDate([{ day: "Monday", date: "" }], "2026-11-16"), null);
});

test("buildPlanSnapshot: raw text stored verbatim and re-parseable", () => {
  const s = pd.buildPlanSnapshot({ isoDate: "2026-11-16", session: MON, fetchedAtMs: ist("2026-11-16", "08:50"), source: "google_doc_live", late: false });
  assert.equal(s.v, 1);
  assert.equal(s.date, "2026-11-16");
  assert.equal(s.fetchedAt, "2026-11-16T03:20:00.000Z");
  assert.equal(s.source, "google_doc_live");
  assert.equal(s.late, false);
  assert.equal(s.raw.stance, MON.stance);
  assert.equal(s.raw.forecast, MON.forecast);
  assert.equal(s.raw.action, MON.action);
  assert.equal(s.raw.sectors, MON.sectors);
  assert.equal(s.raw.sessionTitle, MON.session);
  assert.deepEqual(pd.parsePlanCalls(s.raw), s.parsed);
  assert.equal(pd.buildPlanSnapshot({ isoDate: "2026-11-16", session: MON, fetchedAtMs: 0, source: "redis_cache", late: true }).source, "redis_cache");
});

test("getPlanDocConfig: defaults and env overrides", () => {
  assert.deepEqual(pd.getPlanDocConfig({}), { enabled: true, bandPct: 0.15, snapshotStart: "08:45", snapshotStartMins: 525 });
  const c = pd.getPlanDocConfig({ PLAN_DOC_SHADOW_ENABLED: "false", PLAN_DOC_BAND_PCT: "0.25", PLAN_DOC_SNAPSHOT_START: "08:30" });
  assert.deepEqual(c, { enabled: false, bandPct: 0.25, snapshotStart: "08:30", snapshotStartMins: 510 });
  assert.equal(pd.getPlanDocConfig({ PLAN_DOC_SNAPSHOT_START: "09:30" }).snapshotStart, "08:45", "a start after 09:14 is ignored");
  assert.equal(pd.getPlanDocConfig({ PLAN_DOC_BAND_PCT: "-1" }).bandPct, 0.15);
});

// ─────────────────────────────────────────────────────────────────────────────
//  measurePlanCall
// ─────────────────────────────────────────────────────────────────────────────
const series = (pairs) => ({ m: pairs.map((p) => p[0]), f: pairs.map((p) => p[1]) });
const win = (call, start = 555, end = 720) => ({ call, startMins: start, endMins: end });

test("measurePlanCall: UP / DOWN / FLAT at the band boundaries", () => {
  const at = (endPrice) => pd.measurePlanCall(win("BULLISH"), series([[555, 20000], [600, 20010], [720, endPrice]]));
  assert.equal(at(20030).outcome, "UP"); // +0.15% exactly
  assert.equal(at(20030).movePct, 0.15);
  assert.equal(at(20029.8).outcome, "FLAT"); // +0.149%
  assert.equal(at(19970).outcome, "DOWN"); // −0.15% exactly
  assert.equal(at(19970.2).outcome, "FLAT");
  const r = at(20030);
  assert.deepEqual({ ...r }, { status: "MEASURED", refPrice: 20000, refAt: "09:15", endPrice: 20030, endAt: "12:00", movePct: 0.15, movePts: 30, outcome: "UP", bandPct: 0.15, hit: true });
  // Band override.
  assert.equal(pd.measurePlanCall(win("BULLISH"), series([[555, 20000], [720, 20030]]), { bandPct: 0.2 }).outcome, "FLAT");
});

test("measurePlanCall: each call type hit and miss; UNPARSED not scored", () => {
  const up = series([[555, 20000], [720, 20100]]);
  const down = series([[555, 20000], [720, 19900]]);
  const flat = series([[555, 20000], [720, 20005]]);
  assert.equal(pd.measurePlanCall(win("BULLISH"), up).hit, true);
  assert.equal(pd.measurePlanCall(win("BULLISH"), flat).hit, false);
  assert.equal(pd.measurePlanCall(win("BEARISH"), down).hit, true);
  assert.equal(pd.measurePlanCall(win("BEARISH"), up).hit, false);
  assert.equal(pd.measurePlanCall(win("RANGE"), flat).hit, true);
  assert.equal(pd.measurePlanCall(win("RANGE"), down).hit, false);
  const u = pd.measurePlanCall(win("UNPARSED"), up);
  assert.equal(u.status, "NOT_SCORED");
  assert.equal(u.hit, null);
  assert.equal(u.outcome, "UP", "the window move is still recorded for the base rate");
  assert.equal(pd.measurePlanCall(win("UNPARSED"), series([])).status, "NOT_SCORED");
});

test("measurePlanCall: missing ticks near the window edges → UNMEASURABLE", () => {
  // First tick 6 minutes after the start.
  let r = pd.measurePlanCall(win("BULLISH"), series([[561, 20000], [720, 20100]]));
  assert.equal(r.status, "UNMEASURABLE");
  assert.match(r.reason, /after the window start 09:15/);
  // First tick exactly 5 minutes after the start is accepted (event minutes precede the first tick).
  r = pd.measurePlanCall(win("BULLISH"), series([[560, 20000], [720, 20100]]));
  assert.equal(r.status, "MEASURED");
  assert.equal(r.refAt, "09:20");
  // Last tick 6 minutes before the end.
  r = pd.measurePlanCall(win("BULLISH"), series([[555, 20000], [714, 20100]]));
  assert.equal(r.status, "UNMEASURABLE");
  assert.match(r.reason, /before the window end 12:00/);
  // Ticks after the end are ignored (last at/before the end is used).
  r = pd.measurePlanCall(win("BULLISH"), series([[555, 20000], [716, 20100], [725, 19000]]));
  assert.equal(r.status, "MEASURED");
  assert.equal(r.endAt, "11:56");
  assert.equal(r.outcome, "UP");
  // Zero / null futures are not ticks.
  r = pd.measurePlanCall(win("BULLISH"), { m: [555, 720], f: [null, 20100] });
  assert.equal(r.status, "UNMEASURABLE");
});

// ─────────────────────────────────────────────────────────────────────────────
//  Fake store (scorecard adapter shape) and poll harness
// ─────────────────────────────────────────────────────────────────────────────
function fakeStore({ log = [], failAll = false } = {}) {
  const kv = new Map();
  const lists = new Map();
  const guard = (name, k) => { log.push(`store:${name}:${k}`); if (failAll) throw new Error("store down"); };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    kv, lists, log,
    get: async (k) => { guard("get", k); return kv.has(k) ? clone(kv.get(k)) : null; },
    set: async (k, v) => { guard("set", k); kv.set(k, clone(v)); return "OK"; },
    setNx: async (k, v) => { guard("setNx", k); if (kv.has(k)) return false; kv.set(k, clone(v)); return true; },
    del: async (k) => { guard("del", k); return kv.delete(k) ? 1 : 0; },
    rpush: async (k, v) => { guard("rpush", k); const l = lists.get(k) || []; l.push(clone(v)); lists.set(k, l); return l.length; },
    ltrim: async (k, a, b) => { guard("ltrim", k); lists.set(k, (lists.get(k) || []).slice(a, b + 1)); },
    lrange: async (k) => { guard("lrange", k); return clone(lists.get(k) || []); },
    expire: async () => 1,
    incr: async () => 1,
    mget: async (ks) => ks.map((k) => (kv.has(k) ? clone(kv.get(k)) : null)),
  };
}

function harness({ nowMs, env = {}, store, fetchLive, cached = null, log = [], planMemo = { snapDate: null, eventsDate: null } } = {}) {
  const st = { fetches: 0, cacheReads: 0, refreshes: 0, log };
  const planStore = store || fakeStore({ log });
  const handler = createPollHandler({
    now: () => st.now ?? nowMs,
    getMarketSessionInfo,
    refresh: async (opts) => { st.refreshes++; log.push("refresh"); return { ok: true, persisted: true, snapshotAt: opts.now, ticks: 5, payload: { spotPrice: 25000 }, targetExpiry: "24-Nov-2026" }; },
    getFlowSnapshot: async () => null,
    setHeartbeat: async () => true,
    setNx: async () => true,
    del: async () => 1,
    sendText: async () => true,
    qstashKeys: () => [],
    pushEvent: async () => {},
    setSourceStatus: async () => true,
    env,
    planStore,
    fetchPlanSessionsLive: async () => { st.fetches++; log.push("fetch"); return fetchLive ? fetchLive(st.fetches) : WEEK; },
    getCachedPlanSessions: async () => { st.cacheReads++; log.push("cache"); return typeof cached === "function" ? cached() : cached; },
    planMemo,
  });
  return { handler, st, planStore, planMemo };
}

async function callPoll(handler) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; } };
  await handler({ method: "POST", headers: { "x-webhook-secret": SECRET }, body: {}, query: {} }, res);
  return res;
}

const withSecret = (fn) => async () => {
  const prev = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = SECRET;
  try { await fn(); } finally { if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev; }
};

const SNAP = "nifty:plan:snap:2026-11-16";
const SNAP_LOCK = "nifty:plan:snap_lock:2026-11-16";
const EV_LOCK = "nifty:plan:events_lock:2026-11-16";
const SC_EVENTS = "nifty:sc:events:2026-11-16";
const closedBody = (b) => { const { planSnapshot, ...rest } = b; return rest; };

// ─────────────────────────────────────────────────────────────────────────────
//  Pre-open snapshot
// ─────────────────────────────────────────────────────────────────────────────
test("pre-open: weekday 08:50 takes the snapshot once; the next poll does not refetch", withSecret(async () => {
  const h = harness({ nowMs: ist("2026-11-16", "08:50") });
  const r1 = await callPoll(h.handler);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.status, "MARKET_CLOSED");
  assert.equal(r1.body.planSnapshot, "TAKEN");
  assert.equal(h.st.fetches, 1);
  const snap = h.planStore.kv.get(SNAP);
  assert.equal(snap.date, "2026-11-16");
  assert.equal(snap.late, false);
  assert.equal(snap.source, "google_doc_live");
  assert.equal(snap.raw.stance, MON.stance);
  assert.deepEqual(snap.parsed.calls.map((c) => c.call), ["BULLISH", "BEARISH"]);
  assert.ok(h.planStore.kv.has(SNAP_LOCK));
  h.st.now = ist("2026-11-16", "08:51");
  const r2 = await callPoll(h.handler);
  assert.equal(r2.body.status, "MARKET_CLOSED");
  assert.equal(r2.body.planSnapshot, undefined);
  assert.equal(h.st.fetches, 1, "no second fetch");
  assert.equal(h.planStore.lists.size, 0, "no scorecard events before the open");
}));

test("pre-open: fetch failure releases the lock and a later poll retries", withSecret(async () => {
  const h = harness({ nowMs: ist("2026-11-16", "08:46"), fetchLive: (n) => (n === 1 ? null : WEEK) });
  const r1 = await callPoll(h.handler);
  assert.equal(r1.body.planSnapshot, "RETRY");
  assert.ok(!h.planStore.kv.has(SNAP_LOCK));
  assert.ok(!h.planStore.kv.has(SNAP));
  h.st.now = ist("2026-11-16", "08:47");
  const r2 = await callPoll(h.handler);
  assert.equal(r2.body.planSnapshot, "TAKEN");
  assert.equal(h.st.fetches, 2);
  assert.ok(h.planStore.kv.has(SNAP));
}));

test("pre-open: a throwing fetch is a RETRY, not an error", withSecret(async () => {
  const h = harness({ nowMs: ist("2026-11-16", "08:46"), fetchLive: () => { throw new Error("ETIMEDOUT"); } });
  const r = await callPoll(h.handler);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.planSnapshot, "RETRY");
  assert.ok(!h.planStore.kv.has(SNAP_LOCK));
}));

test("pre-open: a hanging fetch is cut at the fetch timeout and the lock released", async () => {
  const store = fakeStore();
  const r = await pd.takePreOpenPlanSnapshot({ nowMs: ist("2026-11-16", "08:50"), store, env: {}, fetchLiveSessions: () => new Promise(() => {}), fetchTimeoutMs: 30 });
  assert.equal(r.status, "RETRY");
  assert.ok(!store.kv.has(SNAP_LOCK));
});

test("pre-open: document without an entry for today → nothing stored, lock released", withSecret(async () => {
  const lastWeek = WEEK.map((s, i) => ({ ...s, date: `${9 + i} Nov` }));
  const h = harness({ nowMs: ist("2026-11-16", "09:00"), fetchLive: () => lastWeek });
  const r = await callPoll(h.handler);
  assert.equal(r.body.planSnapshot, "NO_ENTRY");
  assert.ok(!h.planStore.kv.has(SNAP));
  assert.ok(!h.planStore.kv.has(SNAP_LOCK));
}));

test("pre-open: before the window, after 09:14 (still closed), on a weekend and when disabled → nothing", withSecret(async () => {
  const cases = [
    { nowMs: ist("2026-11-16", "08:44") },
    { nowMs: ist("2026-11-16", "08:30") },
    { nowMs: ist("2026-11-16", "16:30") },
    { nowMs: ist("2026-11-21", "08:50") }, // Saturday
    { nowMs: ist("2026-11-22", "09:00") }, // Sunday
    { nowMs: ist("2026-11-16", "08:50"), env: { PLAN_DOC_SHADOW_ENABLED: "false" } },
  ];
  for (const c of cases) {
    const log = [];
    const h = harness({ ...c, log });
    const r = await callPoll(h.handler);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.status, "MARKET_CLOSED");
    assert.equal(r.body.planSnapshot, undefined);
    assert.equal(h.st.fetches, 0);
    assert.deepEqual(log, [], "no store call at all");
  }
  // Env override of the window start.
  const h = harness({ nowMs: ist("2026-11-16", "08:31"), env: { PLAN_DOC_SNAPSHOT_START: "08:30" } });
  assert.equal((await callPoll(h.handler)).body.planSnapshot, "TAKEN");
}));

test("pre-open: the MARKET_CLOSED response is otherwise unchanged; a throwing store never changes it", withSecret(async () => {
  const base = await callPoll(harness({ nowMs: ist("2026-11-16", "08:50"), env: { PLAN_DOC_SHADOW_ENABLED: "false" } }).handler);
  assert.deepEqual(Object.keys(base.body).sort(), ["nextOpen", "ok", "source", "status"]);
  const ok = await callPoll(harness({ nowMs: ist("2026-11-16", "08:50") }).handler);
  assert.deepEqual(closedBody(ok.body), base.body);
  const broken = await callPoll(harness({ nowMs: ist("2026-11-16", "08:50"), store: fakeStore({ failAll: true }) }).handler);
  assert.equal(broken.statusCode, 200);
  assert.deepEqual(closedBody(broken.body), base.body);
  const noStore = createPollHandler({ now: () => ist("2026-11-16", "08:50"), getMarketSessionInfo, planStore: null, env: {}, qstashKeys: () => [] });
  const r = await callPoll(noStore);
  assert.deepEqual(r.body, base.body);
}));

// ─────────────────────────────────────────────────────────────────────────────
//  First live poll
// ─────────────────────────────────────────────────────────────────────────────
test("first live poll: appends the snapshot's events exactly once across several polls", withSecret(async () => {
  const log = [];
  const h = harness({ nowMs: ist("2026-11-16", "08:50"), log });
  await callPoll(h.handler); // pre-open snapshot
  h.st.now = ist("2026-11-16", "09:16");
  const r1 = await callPoll(h.handler);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.status, "LIVE_POLL_SUCCESS");
  assert.equal(r1.body.planEvents, "RECORDED");
  for (const t of ["09:17", "09:18", "10:30"]) {
    h.st.now = ist("2026-11-16", t);
    const r = await callPoll(h.handler);
    assert.equal(r.body.status, "LIVE_POLL_SUCCESS");
    assert.equal(r.body.planEvents, undefined);
  }
  const evs = h.planStore.lists.get(SC_EVENTS);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => [e.id, e.section, e.type, e.direction, e.minutes, e.time]), [
    ["PLAN_DOC:FIRST:555:", "PLAN_DOC", "FIRST", "BULLISH", 555, "09:15"],
    ["PLAN_DOC:SECOND:750:", "PLAN_DOC", "SECOND", "BEARISH", 750, "12:30"],
  ]);
  assert.deepEqual(evs[0].data, { half: "FIRST", call: "BULLISH", phrase: "1ST-HALF BOUNCE TO SUPPLY", reason: evs[0].data.reason, conviction: "HIGH", startMins: 555, endMins: 720, late: false, source: "google_doc_live" });
  assert.equal(h.st.fetches, 1, "the live poll never fetches the document");
  assert.equal(h.st.cacheReads, 0, "snapshot existed: cache not read");
  // The refresh ran before any plan work on the live poll.
  const liveLog = log.slice(log.indexOf("refresh"));
  assert.equal(liveLog[0], "refresh");
  assert.ok(log.indexOf(`store:setNx:${EV_LOCK}`) > log.indexOf("refresh"));
}));

test("first live poll: no snapshot → late snapshot from the cache (no network fetch)", withSecret(async () => {
  const h = harness({ nowMs: ist("2026-11-16", "09:20"), cached: { sessions: WEEK, updatedAt: "2026-11-16T03:00:00.000Z" } });
  const r = await callPoll(h.handler);
  assert.equal(r.body.planEvents, "RECORDED");
  assert.equal(h.st.fetches, 0);
  assert.equal(h.st.cacheReads, 1);
  const snap = h.planStore.kv.get(SNAP);
  assert.equal(snap.late, true);
  assert.equal(snap.source, "redis_cache");
  assert.equal(snap.cacheUpdatedAt, "2026-11-16T03:00:00.000Z");
  const evs = h.planStore.lists.get(SC_EVENTS);
  assert.equal(evs.length, 2);
  assert.ok(evs.every((e) => e.data.late === true && e.data.source === "redis_cache"));
}));

test("first live poll: no entry for today anywhere → nothing appended, not retried every poll", withSecret(async () => {
  const lastWeek = WEEK.map((s, i) => ({ ...s, date: `${9 + i} Nov` }));
  const h = harness({ nowMs: ist("2026-11-16", "09:20"), cached: { sessions: lastWeek } });
  assert.equal((await callPoll(h.handler)).body.planEvents, "NO_ENTRY");
  h.st.now = ist("2026-11-16", "09:21");
  assert.equal((await callPoll(h.handler)).body.planEvents, undefined);
  assert.equal(h.st.cacheReads, 1);
  assert.equal(h.planStore.lists.size, 0);
  assert.ok(!h.planStore.kv.has(SNAP));
}));

test("first live poll: a throwing store or cache never changes the poll's status or core body", withSecret(async () => {
  const strip = (b) => { const { planEvents, durationMs, ...rest } = b; return rest; };
  const base = await callPoll(harness({ nowMs: ist("2026-11-16", "09:20"), env: { PLAN_DOC_SHADOW_ENABLED: "false" } }).handler);
  assert.equal(base.body.planEvents, undefined);
  const broken = await callPoll(harness({ nowMs: ist("2026-11-16", "09:20"), store: fakeStore({ failAll: true }) }).handler);
  assert.equal(broken.statusCode, 200);
  assert.deepEqual(strip(broken.body), strip(base.body));
  assert.equal(broken.body.planEvents, undefined);
  const badCache = await callPoll(harness({ nowMs: ist("2026-11-16", "09:20"), cached: () => { throw new Error("redis 500"); } }).handler);
  assert.equal(badCache.statusCode, 200);
  assert.deepEqual(strip(badCache.body), strip(base.body));
  // Disabled: nothing touched.
  const log = [];
  const off = harness({ nowMs: ist("2026-11-16", "09:20"), env: { PLAN_DOC_SHADOW_ENABLED: "false" }, cached: { sessions: WEEK }, log });
  await callPoll(off.handler);
  assert.deepEqual(log.filter((x) => x !== "refresh"), []);
}));

test("first live poll: an error after the claim releases the lock so a later poll retries (ids dedupe)", async () => {
  const store = fakeStore();
  let fail = true;
  const recordEvent = async (args) => { if (fail) throw new Error("rpush failed"); return sc.recordEvent(args); };
  const args = { store, env: {}, getCachedSessions: async () => ({ sessions: WEEK }), buildEvents: sc.buildPlanEvents, recordEvent };
  const r1 = await pd.recordPlanEventsOnce({ ...args, nowMs: ist("2026-11-16", "09:20") });
  assert.equal(r1.status, "ERROR");
  assert.ok(!store.kv.has(EV_LOCK));
  fail = false;
  assert.equal((await pd.recordPlanEventsOnce({ ...args, nowMs: ist("2026-11-16", "09:21") })).status, "RECORDED");
  assert.equal((await pd.recordPlanEventsOnce({ ...args, nowMs: ist("2026-11-16", "09:22") })).status, "ALREADY_DONE");
  assert.equal(store.lists.get(SC_EVENTS).length, 2);
});

test("first live poll: skipped when the poll has used up its time budget (left to the next poll)", withSecret(async () => {
  const h = harness({ nowMs: ist("2026-11-16", "09:20"), cached: { sessions: WEEK } });
  const t0 = ist("2026-11-16", "09:20");
  let refreshed = false; // the refresh "took" 13.8 s
  const slow = createPollHandler({
    now: () => (refreshed ? t0 + 13_800 : t0),
    getMarketSessionInfo,
    refresh: async (opts) => { refreshed = true; return { ok: true, snapshotAt: opts.now, ticks: 1, payload: {} }; },
    getFlowSnapshot: async () => null, setHeartbeat: async () => true, setNx: async () => true, del: async () => 1,
    sendText: async () => true, qstashKeys: () => [], pushEvent: async () => {}, setSourceStatus: async () => true,
    env: {}, planStore: h.planStore, getCachedPlanSessions: async () => ({ sessions: WEEK }),
  });
  const r = await callPoll(slow);
  assert.equal(r.body.status, "LIVE_POLL_SUCCESS");
  assert.equal(r.body.planEvents, undefined);
  assert.ok(!h.planStore.kv.has(EV_LOCK));
}));

// ─────────────────────────────────────────────────────────────────────────────
//  Per-instance memo (api/poll.js)
// ─────────────────────────────────────────────────────────────────────────────
const setNxCount = (log, key) => log.filter((x) => x === `store:setNx:${key}`).length;

test("memo: several live polls on one date make exactly one events-lock SET NX; a new date asks again", withSecret(async () => {
  const log = [];
  const h = harness({ nowMs: ist("2026-11-16", "09:20"), cached: { sessions: WEEK }, log });
  for (const t of ["09:20", "09:21", "09:22", "11:00", "15:00"]) {
    h.st.now = ist("2026-11-16", t);
    assert.equal((await callPoll(h.handler)).body.status, "LIVE_POLL_SUCCESS");
  }
  assert.equal(setNxCount(log, EV_LOCK), 1);
  assert.equal(h.planMemo.eventsDate, "2026-11-16");
  h.st.now = ist("2026-11-17", "09:20");
  await callPoll(h.handler);
  h.st.now = ist("2026-11-17", "09:21");
  await callPoll(h.handler);
  assert.equal(setNxCount(log, "nifty:plan:events_lock:2026-11-17"), 1);
}));

test("memo: lock already taken by another instance ('not claimed') and NO_ENTRY are memoised", withSecret(async () => {
  const log = [];
  const store = fakeStore({ log });
  store.kv.set(EV_LOCK, { at: "other instance" });
  const h = harness({ nowMs: ist("2026-11-16", "09:20"), store, log });
  await callPoll(h.handler);
  h.st.now = ist("2026-11-16", "09:21");
  await callPoll(h.handler);
  assert.equal(setNxCount(log, EV_LOCK), 1);
  const log2 = [];
  const lastWeek = WEEK.map((s, i) => ({ ...s, date: `${9 + i} Nov` }));
  const h2 = harness({ nowMs: ist("2026-11-16", "09:20"), cached: { sessions: lastWeek }, log: log2 });
  assert.equal((await callPoll(h2.handler)).body.planEvents, "NO_ENTRY");
  h2.st.now = ist("2026-11-16", "09:21");
  await callPoll(h2.handler);
  assert.equal(setNxCount(log2, EV_LOCK), 1);
}));

test("memo: an exception in the events step is not memoised (next poll asks again)", withSecret(async () => {
  const log = [];
  const h = harness({ nowMs: ist("2026-11-16", "09:20"), store: fakeStore({ log, failAll: true }), log });
  await callPoll(h.handler);
  h.st.now = ist("2026-11-16", "09:21");
  await callPoll(h.handler);
  assert.equal(setNxCount(log, EV_LOCK), 2);
  assert.equal(h.planMemo.eventsDate, null);
}));

test("memo: pre-open RETRY is asked again on the next poll; TAKEN and 'not claimed' are not", withSecret(async () => {
  const log = [];
  const h = harness({ nowMs: ist("2026-11-16", "08:46"), fetchLive: (n) => (n === 1 ? null : WEEK), log });
  assert.equal((await callPoll(h.handler)).body.planSnapshot, "RETRY");
  assert.equal(h.planMemo.snapDate, null);
  h.st.now = ist("2026-11-16", "08:47");
  assert.equal((await callPoll(h.handler)).body.planSnapshot, "TAKEN");
  assert.equal(h.planMemo.snapDate, "2026-11-16");
  for (const t of ["08:48", "08:49", "09:10"]) {
    h.st.now = ist("2026-11-16", t);
    await callPoll(h.handler);
  }
  assert.equal(setNxCount(log, SNAP_LOCK), 2, "one for the RETRY, one for TAKEN, none after");
  assert.equal(h.st.fetches, 2);
  // Another instance holds the lock: asked once, then remembered.
  const log2 = [];
  const store = fakeStore({ log: log2 });
  store.kv.set(SNAP_LOCK, { at: "other instance" });
  const h2 = harness({ nowMs: ist("2026-11-16", "08:50"), store, log: log2 });
  await callPoll(h2.handler);
  h2.st.now = ist("2026-11-16", "08:51");
  await callPoll(h2.handler);
  assert.equal(setNxCount(log2, SNAP_LOCK), 1);
  assert.equal(h2.st.fetches, 0);
  // Pre-open NO_ENTRY releases the lock (so a fixed document is picked up) and is not memoised.
  const h3 = harness({ nowMs: ist("2026-11-16", "08:50"), fetchLive: () => WEEK.slice(1) });
  assert.equal((await callPoll(h3.handler)).body.planSnapshot, "NO_ENTRY");
  assert.equal(h3.planMemo.snapDate, null);
}));

test("memo: the module-level default memo is used when none is injected, and the test hook resets it", withSecret(async () => {
  resetPlanMemoForTesting();
  const log = [];
  const store = fakeStore({ log });
  const mk = (t) => createPollHandler({
    now: () => ist("2026-11-16", t), getMarketSessionInfo, refresh: async (opts) => ({ ok: true, snapshotAt: opts.now, ticks: 1, payload: {} }),
    getFlowSnapshot: async () => null, setHeartbeat: async () => true, setNx: async () => true, del: async () => 1,
    sendText: async () => true, qstashKeys: () => [], pushEvent: async () => {}, setSourceStatus: async () => true,
    env: {}, planStore: store, getCachedPlanSessions: async () => ({ sessions: WEEK }),
  });
  await callPoll(mk("09:20"));
  await callPoll(mk("09:21")); // a separate handler on the same warm instance shares the memo
  assert.equal(setNxCount(log, EV_LOCK), 1);
  resetPlanMemoForTesting();
  await callPoll(mk("09:22"));
  assert.equal(setNxCount(log, EV_LOCK), 2);
  resetPlanMemoForTesting();
}));

// ─────────────────────────────────────────────────────────────────────────────
//  Scorecard section
// ─────────────────────────────────────────────────────────────────────────────
const snapOf = (session, date, extra = {}) => pd.buildPlanSnapshot({ isoDate: date, session, fetchedAtMs: ist(date, "08:50"), source: "google_doc_live", late: false, ...extra });
/** Compact series 09:17..15:30 every minute: linear from p0 at 09:17 to p1 at 12:00, then to p2 at 15:30. */
function daySeries(p0, p1, p2) {
  const m = [];
  const f = [];
  for (let x = 557; x <= 930; x++) {
    m.push(x);
    f.push(x <= 720 ? p0 + ((p1 - p0) * (x - 557)) / (720 - 557) : p1 + ((p2 - p1) * (x - 720)) / (930 - 720));
  }
  return { m, f: f.map((v) => Math.round(v * 100) / 100), o: [], v: [], s: [], p: [], c: [] };
}

test("scorecard: PLAN_DOC events measured through measureEvent / buildDayDoc (events before the first tick)", () => {
  const evs = sc.buildPlanEvents(snapOf(MON, "2026-11-16"));
  assert.equal(evs.length, 2);
  // Morning up 25000 → 25100 (+0.4%), afternoon down 25100 → 24950.
  const doc = sc.buildDayDoc({ date: "2026-11-16", events: evs, finalEvent: null, series: daySeries(25000, 25100, 24950), settings: {}, dataQuality: null, nowMs: 0 });
  const first = doc.outcomes["PLAN_DOC:FIRST:555:"];
  assert.equal(first.status, "MEASURED");
  assert.equal(first.refAt, "09:17", "event at 09:15 precedes the first tick at 09:17");
  assert.equal(first.outcome, "UP");
  assert.equal(first.hit, true);
  const second = doc.outcomes["PLAN_DOC:SECOND:750:"];
  assert.equal(second.status, "MEASURED");
  assert.equal(second.outcome, "DOWN");
  assert.equal(second.hit, true);
  // measureEvent directly gives the same.
  assert.deepEqual(sc.measureEvent(evs[0], doc.series), first);
  // The public view carries them unchanged.
  const pub = sc.publicDayView(doc);
  assert.deepEqual(pub.events, doc.events);
  assert.deepEqual(pub.outcomes, doc.outcomes);
  // Day CSV has the plan columns.
  const csv = sc.dayToCsv(doc);
  assert.match(csv.split("\n")[0], /,plan_move_pct,plan_outcome$/);
  assert.match(csv, /PLAN_DOC,FIRST,BULLISH/);
  // Wed: the TRAP half is NOT_SCORED.
  const wed = sc.buildPlanEvents(snapOf(WED, "2026-11-18"));
  assert.equal(wed[0].direction, null);
  assert.equal(sc.measureEvent(wed[0], daySeries(25000, 25100, 24950)).status, "NOT_SCORED");
});

test("scorecard: aggregate PLAN_DOC byHalf / byCall / byConviction / outcomeMix; old docs; CSV", () => {
  const mk = (session, date, s) => {
    const events = sc.buildPlanEvents(snapOf(session, date));
    return sc.buildDayDoc({ date, events, finalEvent: null, series: s, settings: {}, dataQuality: null, nowMs: 0 });
  };
  const days = [
    mk(MON, "2026-11-16", daySeries(25000, 25100, 24950)), // FIRST BULLISH UP hit · SECOND BEARISH DOWN hit
    mk(TUE, "2026-11-17", daySeries(25000, 25010, 25200)), // RANGE 555–780 / RANGE 780–930
    mk(WED, "2026-11-18", daySeries(25000, 25100, 25300)), // FIRST UNPARSED (UP, not scored) · SECOND BEARISH (UP → miss)
    { date: "2026-10-01", events: [{ id: "x", section: "SIGNAL", type: "BULL_TRAP_SELL", minutes: 600, data: { category: "VETOED" } }], outcomes: {} }, // old doc
    { date: "2026-10-02" },
  ];
  const agg = sc.aggregate(days);
  const s = agg.sections.PLAN_DOC;
  assert.ok(s.rule.includes("UNPARSED"));
  assert.equal(s.events, 6);
  assert.equal(s.notScored, 1);
  assert.equal(s.measurable, 5);
  const tue = days[1].outcomes;
  const tueHits = Object.values(tue).filter((o) => o.hit).length;
  assert.equal(s.hits, 2 + tueHits);
  assert.deepEqual(Object.keys(s.byHalf), ["FIRST", "SECOND", "FULL"]);
  assert.deepEqual(Object.keys(s.byCall), ["BULLISH", "BEARISH", "RANGE"]);
  assert.deepEqual(Object.keys(s.byConviction), ["HIGHEST", "HIGH", "MEDIUM", "LOW"]);
  assert.equal(s.byCall.BULLISH.measurable, 1);
  assert.equal(s.byCall.BULLISH.hits, 1);
  assert.equal(s.byCall.BEARISH.measurable, 2);
  assert.equal(s.byCall.BEARISH.hits, 1);
  assert.equal(s.byCall.RANGE.measurable, 2);
  assert.equal(s.byHalf.FIRST.events, 3);
  assert.equal(s.byHalf.FULL.events, 0);
  assert.equal(s.byConviction.HIGHEST.events, 2);
  assert.equal(s.byConviction.HIGH.events, 4);
  // Base rate over every measured window, including the not-scored one.
  const outs = days.slice(0, 3).flatMap((d) => Object.values(d.outcomes)).map((o) => o.outcome);
  const count = (k) => outs.filter((x) => x === k).length;
  assert.deepEqual(s.outcomeMix, { UP: count("UP"), DOWN: count("DOWN"), FLAT: count("FLAT"), windows: 6 });
  assert.equal(s.outcomeMix.UP + s.outcomeMix.DOWN + s.outcomeMix.FLAT, 6);
  // Old documents alone aggregate without error.
  const old = sc.aggregate(days.slice(3));
  assert.equal(old.sections.PLAN_DOC.events, 0);
  assert.deepEqual(old.sections.PLAN_DOC.outcomeMix, { UP: 0, DOWN: 0, FLAT: 0, windows: 0 });
  // CSV rows.
  const csv = sc.aggregateToCsv(agg);
  for (const k of ["half:FIRST", "half:SECOND", "half:FULL", "call:BULLISH", "call:BEARISH", "call:RANGE", "conviction:HIGHEST", "conviction:HIGH", "outcome:UP", "outcome:DOWN", "outcome:FLAT"]) {
    assert.ok(csv.includes(`PLAN_DOC,${k},`), k);
  }
  assert.ok(csv.includes(`PLAN_DOC,outcome:UP,,${s.outcomeMix.UP}`));
});

test("scorecard: daily Telegram text unchanged with PLAN_DOC events present (incl. unmeasurable ones)", () => {
  const events = [...sc.buildPlanEvents(snapOf(MON, "2026-11-16")), ...sc.buildPlanEvents(snapOf(WED, "2026-11-16"))];
  // A series that ends at 11:00 → the second half is UNMEASURABLE.
  const s = daySeries(25000, 25100, 24950);
  const cut = { ...s, m: s.m.filter((x) => x <= 660), f: s.f.slice(0, s.m.filter((x) => x <= 660).length) };
  const doc = sc.buildDayDoc({ date: "2026-11-16", events, finalEvent: null, series: cut, settings: {}, dataQuality: { state: "OK", coveragePct: 100 }, nowMs: 0 });
  assert.ok(Object.values(doc.outcomes).some((o) => o.status === "UNMEASURABLE"));
  const base = { ...doc, events: [], outcomes: {} };
  assert.equal(sc.formatDailyTelegram(doc), sc.formatDailyTelegram(base));
  assert.ok(!sc.formatDailyTelegram(doc).includes("PLAN"));
});

test("scorecard: settings snapshot whitelists the PLAN_DOC env names; HIT_RULES has PLAN_DOC", () => {
  const env = { PLAN_DOC_SHADOW_ENABLED: "false", PLAN_DOC_BAND_PCT: "0.2", PLAN_DOC_SNAPSHOT_START: "08:40" };
  assert.deepEqual(
    Object.fromEntries(Object.entries(sc.settingsSnapshot({ env }).envOverrides).filter(([k]) => k.startsWith("PLAN_DOC"))),
    env,
  );
  assert.equal(typeof sc.HIT_RULES.PLAN_DOC, "string");
  assert.deepEqual(sc.buildPlanEvents(null), []);
  assert.deepEqual(sc.buildPlanEvents({ date: "bad", parsed: { calls: [] } }), []);
});

test("api/scorecard: the day view exposes the stored snapshot read-only as planDoc", withSecret(async () => {
  const { createScorecardHandler } = await import("../api/scorecard.js");
  const store = fakeStore();
  const snap = snapOf(MON, "2026-11-16");
  store.kv.set(SNAP, snap);
  const evs = sc.buildPlanEvents(snap);
  store.lists.set(SC_EVENTS, evs);
  const h = createScorecardHandler({ store, now: () => ist("2026-11-16", "11:00"), getTimeline: async () => [], settings: () => ({}), send: async () => true });
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } };
  await h({ method: "GET", query: { date: "2026-11-16" }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.planDoc.raw.stance, MON.stance);
  assert.equal(res.body.planDoc.late, false);
  assert.equal(res.body.events.length, 2);
  assert.ok(!store.log.some((x) => x.startsWith("store:set:") || x.startsWith("store:setNx:nifty:plan")), "read-only");
}));

// ─────────────────────────────────────────────────────────────────────────────
//  First live tick of the session (carry-over quotes at the open)
// ─────────────────────────────────────────────────────────────────────────────
const so = await import("../src/sessionOpen.js");
// Mon 2026-11-16 as recorded: 09:15 is Friday's quote and cumulative volume.
const NOV16 = {
  m: [555, 556, 557, 558, 559, 561, 600, 660, 720],
  f: [25175, 25275, 25284.4, 25281.7, 25270.7, 25273.1, 25290, 25260, 25273],
  s: [25206.15, 25299.9, 25299.9, 25229.7, 25258.4, 25256, 25300, 25270, 25280],
  o: [208489, 208312, 208312, 207518, 207379, 207297, 207100, 206900, 206800],
  v: [2733315, 68835, 61620, 187070, 233480, 255190, 900000, 1500000, 2000000],
};
// Fri 2026-11-13 shape: two carry-over ticks, the reset at the third.
const NOV13 = {
  m: [555, 556, 557, 558, 559, 560, 561, 570],
  f: [25314, 25314, 25170, 25172, 25168, 25175, 25171, 25180],
  o: [216128, 216128, 212215, 212200, 212190, 212180, 212170, 212100],
  v: [3559335, 3559335, 20000, 45000, 70000, 95000, 120000, 300000],
};
const without = (s, k) => { const { [k]: _, ...rest } = s; return rest; };

test("firstLiveIndex: volume reset (16-Nov one stale tick, 13-Nov two), clean open, window limit", () => {
  assert.deepEqual([so.firstLiveIndex(NOV16).index, so.firstLiveIndex(NOV16).skipped, so.firstLiveIndex(NOV16).minutes], [1, 1, 556]);
  assert.deepEqual([so.firstLiveIndex(NOV13).index, so.firstLiveIndex(NOV13).skipped], [2, 2]);
  const clean = { ...NOV16, v: [10000, 68835, 70000, 187070, 233480, 255190, 900000, 1500000, 2000000] };
  assert.deepEqual([so.firstLiveIndex(clean).index, so.firstLiveIndex(clean).skipped], [0, 0]);
  // A volume drop 12 minutes in is outside the 10-minute look window: ignored.
  const late = { m: [555, 558, 561, 564, 567, 570], f: [25000, 25010, 25020, 25030, 25040, 25050], v: [1000, 2000, 3000, 4000, 100, 5000] };
  assert.deepEqual([so.firstLiveIndex(late).index, so.firstLiveIndex(late).skipped], [0, 0]);
  assert.equal(so.SESSION_OPEN_MAX_LOOK_MIN, 10);
});

test("firstLiveIndex: OI-and-price fallback without volume; fast real open kept; too few followers", () => {
  const r = so.firstLiveIndex(without(NOV13, "v"));
  assert.deepEqual([r.index, r.skipped], [2, 2], "13-Nov numbers without volume: OI −1.8% and price −0.57% → carry-over");
  const fast = { ...without(NOV13, "v"), o: NOV13.o.map(() => 212200) };
  assert.equal(so.firstLiveIndex(fast).skipped, 0, "price moved but OI did not → a real fast open");
  const three = { m: [555, 556, 557], f: [25314, 25314, 25170], o: [216128, 216128, 212215] };
  assert.equal(so.firstLiveIndex(three).skipped, 0, "fewer than 3 followers → no skip");
  const nullVol = { ...NOV13, v: NOV13.v.map(() => null) };
  assert.equal(so.firstLiveIndex(nullVol).index, 2, "null volumes fall back to OI and price");
});

test("firstLiveIndex: empty / malformed input never throws", () => {
  assert.equal(so.firstLiveIndex(null).index, -1);
  assert.equal(so.firstLiveIndex({}).index, -1);
  assert.equal(so.firstLiveIndex({ m: [] }).index, -1);
  assert.equal(so.firstLiveIndex({ m: ["x", 2] }).skipped, 0);
  assert.equal(so.firstLiveIndex({ m: [555, 556], v: "junk", f: null }).skipped, 0);
});

test("measurePlanCall: 16-Nov first half measured from the first live tick (09:16), not Friday's quote", () => {
  const r = pd.measurePlanCall(win("BULLISH", 555, 720), NOV16);
  assert.equal(r.status, "MEASURED");
  assert.deepEqual([r.refPrice, r.refAt, r.endPrice, r.endAt, r.outcome, r.hit, r.refShifted, r.staleSkipped], [25275, "09:16", 25273, "12:00", "FLAT", false, true, 1]);
  assert.ok(Math.abs(r.movePct - -0.0079) < 0.0002, String(r.movePct));
  // Before the fix the same ticks gave 25175 @09:15 → +0.389% UP, a false hit.
});

test("measurePlanCall: clean open and mid-session windows unchanged; live tick > 10 min late → UNMEASURABLE", () => {
  const clean = { ...NOV16, f: [25275, ...NOV16.f.slice(1)], v: [10000, ...NOV16.v.slice(1)], o: [208312, ...NOV16.o.slice(1)] };
  const c = pd.measurePlanCall(win("BULLISH", 555, 720), clean);
  assert.deepEqual([c.refAt, c.refPrice, "refShifted" in c, "staleSkipped" in c], ["09:15", 25275, false, false]);
  assert.deepEqual(c, pd.measurePlanCall(win("BULLISH", 555, 720), { m: clean.m, f: clean.f }), "same as the price-only rule");
  const mid = pd.measurePlanCall(win("BEARISH", 600, 720), NOV16);
  assert.deepEqual([mid.refAt, mid.refPrice, "refShifted" in mid], ["10:00", 25290, false]);
  // Carry-over ticks 09:15–09:24, the volume resets at 09:25; window starts 09:14 → 11 min late.
  const m = [555, 556, 557, 558, 559, 560, 561, 562, 563, 564, 565, 566, 567, 720];
  const lateLive = { m, f: m.map((x) => (x < 565 ? 25000 : 25100)), v: m.map((x) => (x < 565 ? 3000000 : 10000 + x)) };
  const u = pd.measurePlanCall(win("BULLISH", 554, 720), lateLive);
  assert.equal(u.status, "UNMEASURABLE");
  assert.match(u.reason, /first live futures tick 09:25 is more than 10 min after the window start 09:14/);
  assert.equal(pd.measurePlanCall(win("BULLISH", 555, 720), lateLive).refAt, "09:25", "exactly 10 min is allowed");
});
