#!/usr/bin/env node
/**
 * One-off scorecard backfill for 11-Nov-2026 and 12-Nov-2026 from the captured payloads in
 * test/fixtures/. Never runs on deploy.
 *
 *   node scripts/backfill-scorecard.mjs                 # dry run: prints the summary, writes nothing
 *   node scripts/backfill-scorecard.mjs --out <dir>     # also saves the two day documents as JSON
 *   TV_WEBHOOK_SECRET=… node scripts/backfill-scorecard.mjs --post https://niftyninjaa.vercel.app
 *                                                        # POSTs each document to /api/scorecard
 *                                                        # (authenticated action "backfill")
 *
 * What can be reconstructed from a captured payload: the per-minute series, the Turn Tracker and the
 * 30-minute radar (recomputed minute by minute with the current code), whole-day quadrant changes
 * (the quadrant stored on each tick) and the final EOD reading as captured. Not reconstructable:
 * fusion scenario changes, per-slot EOD readings, TradingView signals and trades.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeTurnTracker } from "../src/turnTracker.js";
import { computeDataQuality } from "../src/dataQuality.js";
import { captureEvents, buildDayDoc, compactSeries, measureEodNext, getScorecardConfig, formatDailyTelegram } from "../src/scorecard.js";
import { detectMacroTurn, getEodCarryCategory, scorecardSettings } from "../api/nifty-oi.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (d) => path.join(HERE, "..", "test", "fixtures", `nifty-oi-2026-11-${d}.json`);

/** Replays one captured payload into a backfilled day document. */
export function backfillDay(fixture, date, { captureNote } = {}) {
  const TL = (fixture.intradayTimeline || []).filter((p) => p && Number.isFinite(Number(p.minutes))).slice().sort((a, b) => a.minutes - b.minutes);
  let state = null;
  const events = [];
  for (const tick of TL) {
    const m = tick.minutes;
    const upTo = TL.filter((p) => p.minutes <= m);
    const { _gapMins, ...dq } = computeDataQuality({ timeline: upTo, nowMins: m, isLive: false });
    const reading = {
      t: Date.parse(`${date}T00:00:00+05:30`) + m * 60000,
      minutes: m,
      futPrice: Number(tick.futPrice) > 0 ? Number(tick.futPrice) : null,
      spot: tick.spot,
      futuresExpiry: fixture.futures?.expiryDate || null,
      dq: { state: dq.state, coveragePct: dq.coveragePct },
      fusion: { quadrant: tick.futQuadrant || null, scenario: null },
      turn: computeTurnTracker({ timeline: TL, nowMins: m }),
      radar: detectMacroTurn({ timeline: upTo, spot: tick.spot, floorStrike: fixture.floor, roofStrike: fixture.roof }),
      eod: null,
    };
    const r = captureEvents(state, reading);
    state = r.state;
    events.push(...r.events);
  }
  // Final EOD reading as captured (the payload's own eodDecision at its last tick).
  const last = TL[TL.length - 1];
  const eod = fixture.eodDecision || null;
  const category = eod ? getEodCarryCategory(eod) : null;
  const final = eod && last ? {
    id: `EOD:FINAL:${last.minutes}:`, key: "final", t: Date.parse(`${date}T00:00:00+05:30`) + last.minutes * 60000,
    time: last.time, minutes: last.minutes, section: "EOD", type: "FINAL",
    direction: category === "BTST" ? "BULLISH" : category === "STBT" ? "BEARISH" : null,
    futPrice: Number(last.futPrice) > 0 ? Number(last.futPrice) : null, spot: last.spot,
    data: { verdict: eod.verdict, category, score: eod.score, groups: { A: eod.groups?.A?.contribution ?? null, B: eod.groups?.B?.contribution ?? null, C: eod.groups?.C?.contribution ?? null }, unverifiedGroups: eod.unverifiedGroups || [], stopLoss: eod.stopLoss ?? null, capturedAs: "payload eodDecision (pre-12-Nov scoring rules)" },
    dq: { ok: !(eod.unverifiedGroups || []).length, text: null },
    futuresExpiry: fixture.futures?.expiryDate || null,
  } : null;
  const { _gapMins, ...dayDq } = computeDataQuality({ timeline: TL, nowMins: 940, isLive: false });
  const doc = buildDayDoc({
    date, events, finalEvent: final, series: compactSeries(TL), settings: { ...scorecardSettings({}), note: "settings of the current code, not of the day" },
    dataQuality: dayDq, cfg: getScorecardConfig({}), backfilled: true, futuresExpiry: fixture.futures?.expiryDate || null,
    notes: [
      "BACKFILLED from a captured payload, not recorded live.",
      captureNote,
      "Turn Tracker and 30-min radar recomputed minute by minute with the current code (what the live panel showed that day may differ).",
      "Whole-day quadrant changes from the quadrant stored on each tick; fusion scenario changes, per-slot EOD readings, TradingView signals and trades are not reconstructable.",
      `Data gaps: ${dayDq.gaps.map((g) => `${g.from}–${g.to}`).join(", ") || "none"}.`,
    ].filter(Boolean),
  });
  return doc;
}

export function buildBackfill() {
  const f11 = JSON.parse(fs.readFileSync(FIX("11"), "utf8"));
  const f12 = JSON.parse(fs.readFileSync(FIX("12"), "utf8"));
  const d11 = backfillDay(f11, "2026-11-11", { captureNote: "Captured 11-Nov after the close; ticks sparse all day (120 of 386)." });
  const d12 = backfillDay(f12, "2026-11-12", { captureNote: "Captured 12-Nov 15:46 IST; poller ticks every minute to 11:38, sparse browser ticks after." });
  // 11-Nov's final EOD verdict, measured on 12-Nov's opening ticks.
  if (d11.eodFinal) d11.eodOutcome = measureEodNext(d11.eodFinal, compactSeries(f12.intradayTimeline), { nextDate: "2026-11-12", nextFuturesExpiry: f12.futures?.expiryDate || null });
  if (d12.eodFinal) d12.eodOutcome = { status: "PENDING", reason: "no captured 13-Nov ticks; completed live by the next session's refresh only if recorded live" };
  return [d11, d12];
}

function summary(doc) {
  const rows = [...doc.events.map((e) => ({ e, o: doc.outcomes[e.id] })), ...(doc.eodFinal ? [{ e: doc.eodFinal, o: doc.eodOutcome }] : [])];
  const by = {};
  for (const { e, o } of rows) {
    const s = (by[e.section] ||= { events: 0, measured: 0, hits: 0, unmeasurable: 0, nonDirectional: 0, pending: 0 });
    s.events++;
    if (o?.status === "MEASURED") { s.measured++; if (o.hit) s.hits++; }
    else if (o?.status === "UNMEASURABLE") s.unmeasurable++;
    else if (o?.status === "NOT_DIRECTIONAL") s.nonDirectional++;
    else if (o?.status === "PENDING") s.pending++;
  }
  return by;
}

async function main() {
  const args = process.argv.slice(2);
  const days = buildBackfill();
  for (const d of days) {
    console.log(`\n=== ${d.date} (backfilled) — coverage ${d.dataQuality.coveragePct}% ===`);
    console.log(JSON.stringify(summary(d)));
    console.log(formatDailyTelegram(d));
    if (d.eodOutcome) console.log("EOD outcome:", JSON.stringify(d.eodOutcome));
    console.log(`day document size: ${Buffer.byteLength(JSON.stringify(d))} bytes`);
  }
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0) {
    const dir = args[outIdx + 1];
    fs.mkdirSync(dir, { recursive: true });
    for (const d of days) fs.writeFileSync(path.join(dir, `scorecard-${d.date}.json`), JSON.stringify(d, null, 1));
    console.log(`saved to ${dir}`);
  }
  const postIdx = args.indexOf("--post");
  if (postIdx >= 0) {
    const base = String(args[postIdx + 1] || "").replace(/\/$/, "");
    const secret = process.env.TV_WEBHOOK_SECRET;
    if (!base || !secret) throw new Error("--post <baseUrl> needs TV_WEBHOOK_SECRET in the environment");
    for (const d of days) {
      const r = await fetch(`${base}/api/scorecard`, { method: "POST", headers: { "Content-Type": "application/json", "x-webhook-secret": secret }, body: JSON.stringify({ action: "backfill", day: d }) });
      console.log(d.date, r.status, await r.text());
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
