#!/usr/bin/env node
/**
 * Daily cloud archive of the recorded market data (owner 2026-11-20). Redis keeps the raw minute
 * timeline 14 days and the scorecard 180 days; this copies every finished session into a folder
 * (a private GitHub repo, see docs/data-archive.md) so months of history can be analysed later.
 *
 *   ARCHIVE_SECRET=… node scripts/archive-export.mjs --out ./archive [--days 12] [--base https://niftyninjaa.vercel.app]
 *
 * Idempotent and self-healing: each run walks back --days calendar days and fills in any session
 * that is not complete yet, so a delayed or dropped scheduled run loses nothing as long as one run
 * happens within the 14-day raw-timeline window. Per session (days/YYYY-MM/YYYY-MM-DD/):
 *   scorecard.json.gz  scorecard day (events, outcomes, compact per-minute series; rupees included)
 *   timeline.json.gz   raw per-minute timeline
 *   signals.json.gz    TradingView signals and trades of the day
 *   swing.json         daily swing summary (Weekly Outlook input)
 *   manifest.json      what was saved, when, and whether the session is complete
 * Plus latest/ snapshots (overwritten each run): rolling scorecard, Weekly Outlook, signal CSV.
 * Read-only against the API; never writes to Redis.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { getSessionKindForDate } from "../src/marketCalendar.js";

export const RAW_TIMELINE_DAYS = 14;
// First scorecard day. Never read earlier dates: GET /api/scorecard?date=… lazily FINALISES a day that
// has a timeline but no scorecard document (writing it and sending its daily Telegram).
export const ARCHIVE_SINCE = "2026-11-11";
const IST_MS = 5.5 * 3600e3;
const READY_MINS = 15 * 60 + 50; // today's session is archived only after 15:50 IST (finalised at 15:38)

const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMins = (ms) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const ageDays = (iso, nowMs) => Math.round((Date.parse(`${istDate(nowMs)}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400e3);

/** Weekday dates to consider, newest first; today only once the session has been finalised. */
export function exportDates({ nowMs, days = 12, since = ARCHIVE_SINCE }) {
  const today = istDate(nowMs);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = shift(today, -i);
    if (i === 0 && istMins(nowMs) < READY_MINS) continue;
    if (d < since) break;
    if (dow(d) === 0 || dow(d) === 6) continue; // a Muhurat weekend session is archived with --date
    if (getSessionKindForDate(d) === "CLOSED") continue; // weekday exchange holiday
    out.push(d);
  }
  return out;
}

export const dayDir = (out, date) => path.join(out, "days", date.slice(0, 7), date);

const writeGz = (file, obj) => fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(obj), { level: 9 }));
const writeJson = (file, obj) => fs.writeFileSync(file, `${JSON.stringify(obj, null, 1)}\n`);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; } };

/** One session. Returns a status string. */
export async function exportDay({ out, date, get, nowMs, swingDays = [] }) {
  const dir = dayDir(out, date);
  const prev = readJson(path.join(dir, "manifest.json"));
  if (prev?.complete) {
    // A swing summary can be corrected after the day was archived (21-Nov-2026: spot highs/lows
    // replaced by the NSE daily bar). Refresh swing.json whenever the source differs; the archive's
    // git history keeps the earlier version. Nothing else of a complete day is re-read.
    const swingNow = prev.noSession ? null : swingDays.find((d) => d?.date === date);
    const file = path.join(dir, "swing.json");
    if (swingNow && JSON.stringify(readJson(file)) !== JSON.stringify(swingNow)) {
      writeJson(file, swingNow);
      writeJson(path.join(dir, "manifest.json"), { ...prev, swing: true, swingUpdatedAt: new Date(nowMs).toISOString() });
      return "already complete; swing summary updated";
    }
    return "already complete";
  }
  const sc = await get(`/api/scorecard?date=${date}&series=1`, { auth: true });
  if (!sc?.ok) return `scorecard unavailable (${sc?.error || "no response"})`;
  if (sc.noSession) {
    if (prev) return "no session";
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "manifest.json"), { date, noSession: true, reason: sc.reason || null, fetchedAt: new Date(nowMs).toISOString(), complete: true });
    return "no session";
  }
  if (!sc.finalisedAt) return "not finalised yet";
  if (sc.authenticated !== true) return "secret rejected (rupee results would be missing)";
  const tl = await get(`/api/scorecard?date=${date}&timeline=1`, { auth: true });
  const sig = await get(`/api/tv-webhook?date=${date}`, { auth: false });
  const points = Array.isArray(tl?.timeline) ? tl.timeline.length : 0;
  const expired = ageDays(date, nowMs) >= RAW_TIMELINE_DAYS;
  fs.mkdirSync(dir, { recursive: true });
  writeGz(path.join(dir, "scorecard.json.gz"), sc);
  if (points) writeGz(path.join(dir, "timeline.json.gz"), tl.timeline);
  if (sig) writeGz(path.join(dir, "signals.json.gz"), sig);
  const swing = swingDays.find((d) => d?.date === date);
  if (swing) writeJson(path.join(dir, "swing.json"), swing);
  const manifest = {
    date,
    fetchedAt: new Date(nowMs).toISOString(),
    finalisedAt: sc.finalisedAt,
    coveragePct: sc.dataQuality?.coveragePct ?? null,
    events: Array.isArray(sc.events) ? sc.events.length : null,
    seriesPoints: sc.seriesPoints ?? null,
    timelinePoints: points,
    timelineMissing: points === 0,
    signals: Boolean(sig),
    swing: Boolean(swing),
    // a missing raw timeline is retried until it can no longer exist in Redis
    complete: (points > 0 || expired) && Boolean(sig),
  };
  writeJson(path.join(dir, "manifest.json"), manifest);
  return manifest.complete ? `saved (${points} timeline points, ${manifest.events} events)` : "saved partially, will retry";
}

export async function runExport({ out, base, secret, nowMs = Date.now(), days = 12, only = null, fetchImpl = fetch, log = console.log }) {
  const get = async (p, { auth = false, text = false } = {}) => {
    try {
      const r = await fetchImpl(`${base}${p}`, { headers: auth ? { "x-webhook-secret": secret } : {} });
      if (!r.ok) return text ? null : { ok: false, error: `HTTP ${r.status}` };
      return text ? await r.text() : await r.json();
    } catch (e) {
      return text ? null : { ok: false, error: String(e?.message || e) };
    }
  };
  fs.mkdirSync(path.join(out, "latest"), { recursive: true });
  const swing = await get("/api/swing?days=60");
  const swingDays = Array.isArray(swing?.days) ? swing.days : [];
  const results = {};
  if (only && only < ARCHIVE_SINCE) throw new Error(`--date before ${ARCHIVE_SINCE} (the first scorecard day) is refused`);
  for (const date of only ? [only] : exportDates({ nowMs, days })) {
    results[date] = await exportDay({ out, date, get, nowMs, swingDays });
    log(`${date}: ${results[date]}`);
  }
  // rolling snapshots (overwritten each run; git history keeps the old ones)
  if (swing?.ok) writeJson(path.join(out, "latest", "weekly-outlook.json"), swing);
  const agg = await get("/api/scorecard?days=180", { auth: true });
  if (agg?.ok) writeJson(path.join(out, "latest", "scorecard-rolling-180d.json"), agg);
  const csv = await get("/api/tv-webhook?export=csv", { text: true });
  if (csv) fs.writeFileSync(path.join(out, "latest", "signals-master.csv"), csv);
  // index of every archived session
  const index = [];
  const daysRoot = path.join(out, "days");
  for (const month of fs.existsSync(daysRoot) ? fs.readdirSync(daysRoot).sort() : []) {
    for (const d of fs.readdirSync(path.join(daysRoot, month)).sort()) {
      const m = readJson(path.join(daysRoot, month, d, "manifest.json"));
      if (m) index.push({ date: m.date, noSession: Boolean(m.noSession), complete: Boolean(m.complete), coveragePct: m.coveragePct ?? null, timelinePoints: m.timelinePoints ?? null, events: m.events ?? null });
    }
  }
  writeJson(path.join(out, "index.json"), { updatedAt: new Date(nowMs).toISOString(), sessions: index.filter((x) => !x.noSession).length, days: index });
  const failed = Object.entries(results).filter(([, s]) => /unavailable|rejected/.test(s));
  return { results, failed: failed.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const out = arg("out");
  const secret = process.env.ARCHIVE_SECRET || process.env.TV_WEBHOOK_SECRET;
  if (!out || !secret) {
    console.error("usage: ARCHIVE_SECRET=… node scripts/archive-export.mjs --out <dir> [--days 12] [--date YYYY-MM-DD]");
    process.exit(2);
  }
  const r = await runExport({ out, secret, base: String(arg("base", "https://niftyninjaa.vercel.app")).replace(/\/$/, ""), days: Number(arg("days", 12)), only: arg("date") });
  if (r.failed) { console.error(`${r.failed} session(s) failed`); process.exit(1); }
}
