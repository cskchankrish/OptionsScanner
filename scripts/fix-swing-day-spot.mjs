#!/usr/bin/env node
/**
 * One-off correction of stored swing day summaries' spot high / low (nifty:swing:day:<date>).
 *
 * Why: summaries captured before 21-Nov-2026 built the day's spot high/low from snapshots taken
 * about once a minute, which miss the extremes between snapshots: highs come out too low and lows
 * too high (20-Nov-2026: recorded low 25368 = the open; NSE's low was 25345.2). Captures from
 * 23-Nov-2026 on read NSE's index quote instead (src/swingSummary.js reconcileSpotWithQuote).
 *
 * Safe by default:
 *   - DRY RUN unless --apply is given (prints before / after for every date; writes nothing);
 *   - every change must state the value it expects to find (--expect / "expect"); if ANY stored
 *     value differs, NOTHING is written (all dates are checked before the first write);
 *   - keeps each key's remaining TTL, keeps the original tick values in spot.ticks, sets
 *     spot.source = "manual-nse-correction" and appends a note per corrected field.
 *
 * Credentials come from YOUR environment (never from a file): UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN). The token is never printed.
 *
 * Usage, one field:
 *   node scripts/fix-swing-day-spot.mjs --date 2026-11-20 --field low --expect 25368 --value 25345.2 [--apply]
 * Usage, a list (JSON array of { date, field, expect, value }):
 *   node scripts/fix-swing-day-spot.mjs --batch scripts/data/swing-spot-corrections-2026-11.json [--apply]
 *
 * Days with NO stored summary (11–13 Nov 2026, recorded before the capture existed) are derived on
 * every read from the scorecard day (src/swingSummary.js summaryFromScorecardDoc), so there is
 * nothing to patch. For those, the script derives the summary exactly as the app does, checks the
 * derived values against "expect", applies the NSE values and STORES it (SET NX: never overwrites
 * an existing summary; TTL = 400 days from the session date). The app then reads the stored copy.
 * Fields: open, high, low.
 */
import fs from "fs";
import { summaryFromScorecardDoc, swingKeys } from "../src/swingSummary.js";
import { keys as scKeys, isSessionDayDoc } from "../src/scorecard.js";

const RETENTION_DAYS = 400; // SWING_RETENTION_DAYS default

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes("--apply");

// Errors throw and are reported at the end (process.exit() with open fetch handles crashes Node on Windows).
class Stop extends Error {}
function fail(msg) {
  throw new Stop(msg);
}

async function main() {

let changes;
if (opt("batch")) {
  try {
    changes = JSON.parse(fs.readFileSync(opt("batch"), "utf8"));
  } catch (e) {
    fail(`cannot read --batch file: ${e.message}`);
  }
  if (!Array.isArray(changes) || !changes.length) fail("--batch file must be a non-empty JSON array");
} else {
  changes = [{ date: opt("date"), field: opt("field"), expect: Number(opt("expect")), value: Number(opt("value")) }];
}
for (const c of changes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.date || ""))) fail(`bad date ${JSON.stringify(c.date)} (YYYY-MM-DD)`);
  if (!["low", "high", "open"].includes(c.field)) fail(`${c.date}: field must be open, high or low`);
  if (!Number.isFinite(Number(c.expect)) || !Number.isFinite(Number(c.value)) || !(Number(c.value) > 0)) fail(`${c.date} ${c.field}: expect and value must be numbers`);
}

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
if (!URL_ || !TOKEN) fail("set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in this terminal first");

async function cmd(arr) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(arr), signal: AbortSignal.timeout(8000) });
  if (!r.ok) fail(`Redis HTTP ${r.status}`);
  const j = await r.json();
  if (j && j.error) fail(`Redis error: ${j.error}`);
  return j ? j.result : null;
}

const byDate = new Map();
for (const c of changes) byDate.set(c.date, [...(byDate.get(c.date) || []), c]);
const today = new Date().toISOString().slice(0, 10);

// 1. read and check everything first
const plans = [];
for (const [date, cs] of byDate) {
  const key = swingKeys.day(date);
  const raw = await cmd(["GET", key]);
  let doc;
  let derived = false;
  if (!raw) {
    // no stored summary: derive it from the scorecard day, as GET /api/swing does
    const scRaw = await cmd(["GET", scKeys.day(date)]);
    if (!scRaw) fail(`${key} not found and no scorecard day ${scKeys.day(date)} to derive it from`);
    let sc;
    try {
      sc = typeof scRaw === "string" ? JSON.parse(scRaw) : scRaw;
    } catch (e) {
      fail(`${scKeys.day(date)} is not JSON`);
    }
    if (!isSessionDayDoc(sc)) fail(`${scKeys.day(date)} is not a session day`);
    doc = summaryFromScorecardDoc(sc);
    if (!doc) fail(`${date}: the scorecard day yields no summary`);
    derived = true;
  } else {
    try {
      doc = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      fail(`${key} is not JSON`);
    }
  }
  if (!doc || doc.date !== date || !doc.spot) fail(`${key} has no spot bar for ${date}`);
  const spot = { ...doc.spot };
  const notes = [];
  for (const c of cs) {
    const old = Number(doc.spot[c.field]);
    if (Math.abs(old - Number(c.expect)) > 0.001) fail(`${date}: ${derived ? "derived" : "stored"} spot.${c.field} is ${old}, not the expected ${c.expect}; NOTHING was written`);
    spot[c.field] = Number(c.value);
    notes.push(`spot.${c.field} corrected ${old} → ${c.value} from the NSE daily bar (manual, ${today}); ${derived ? "the scorecard series held minute snapshots and gap-bridging (interpolated) ticks" : "minute snapshots missed the extreme"}`);
  }
  if (spot.low > spot.high) fail(`${date}: low ${spot.low} would be above high ${spot.high}`);
  if (spot.low > Math.min(spot.open, spot.close)) fail(`${date}: low ${spot.low} would be above the open/close`);
  if (spot.high < Math.max(spot.open, spot.close)) fail(`${date}: high ${spot.high} would be below the open/close`);
  spot.ticks = doc.spot.ticks || { open: doc.spot.open, high: doc.spot.high, low: doc.spot.low };
  spot.source = "manual-nse-correction";
  if (derived) notes.push(`stored on ${today} from the scorecard-derived summary so the NSE correction persists (was derived on read)`);
  plans.push({ key, date, derived, before: doc.spot, updated: { ...doc, spot, notes: [...(Array.isArray(doc.notes) ? doc.notes : []), ...notes] } });
}

for (const p of plans) {
  console.log(`${p.key}${p.derived ? " (no stored summary: will be created from the scorecard-derived one)" : ""}`);
  console.log(`  before: O ${p.before.open} H ${p.before.high} L ${p.before.low} C ${p.before.close}`);
  console.log(`  after:  O ${p.updated.spot.open} H ${p.updated.spot.high} L ${p.updated.spot.low} C ${p.updated.spot.close}`);
}
if (!apply) {
  console.log(`DRY RUN: ${plans.length} record(s) checked, nothing written. Add --apply to write.`);
  return;
}

// 2. write
for (const p of plans) {
  let ttl;
  let setArgs;
  if (p.derived) {
    const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 86400000);
    ttl = Math.max(86400, (RETENTION_DAYS - ageDays) * 86400);
    setArgs = ["SET", p.key, JSON.stringify(p.updated), "NX", "EX", String(ttl)];
  } else {
    ttl = Number(await cmd(["TTL", p.key]));
    setArgs = ttl > 0 ? ["SET", p.key, JSON.stringify(p.updated), "EX", String(ttl)] : ["SET", p.key, JSON.stringify(p.updated)];
  }
  const res = await cmd(setArgs);
  if (res !== "OK") fail(`${p.key}: SET returned ${res}${p.derived ? " (a stored summary appeared meanwhile; nothing overwritten)" : ""}`);
  const check = JSON.parse(await cmd(["GET", p.key]));
  console.log(`WRITTEN ${p.key}: H ${check.spot.high} L ${check.spot.low} (TTL kept: ${ttl > 0 ? `${Math.round(ttl / 86400)} days` : "none"})`);
}
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Stop ? e.message : e?.stack || e}`);
  process.exitCode = 1;
});
