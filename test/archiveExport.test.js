import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

for (const k of ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) delete process.env[k];

const { exportDates, exportDay, runExport, dayDir } = await import("../scripts/archive-export.mjs");
const { createScorecardHandler } = await import("../api/scorecard.js");

const at = (iso, hh, mm) => Date.parse(`${iso}T00:00:00Z`) + (hh * 60 + mm - 330) * 60e3; // IST wall clock → ms
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));

test("dates: weekends skipped; today only after 15:50 IST", () => {
  // Friday 20-Nov-2026
  assert.deepEqual(exportDates({ nowMs: at("2026-11-20", 12, 0), days: 5 }), ["2026-11-19", "2026-11-18", "2026-11-17", "2026-11-16"]);
  assert.deepEqual(exportDates({ nowMs: at("2026-11-20", 16, 0), days: 5 }), ["2026-11-20", "2026-11-19", "2026-11-18", "2026-11-17", "2026-11-16"]);
  assert.deepEqual(exportDates({ nowMs: at("2026-11-23", 9, 0), days: 4 }), ["2026-11-20"], "Monday morning: Friday, weekend skipped");
});

function fakeApi({ finalised = true, noSession = false, points = 3, authed = true } = {}) {
  const calls = [];
  const get = async (p, opts = {}) => {
    calls.push([p, opts.auth === true]);
    if (p.includes("timeline=1")) return { ok: true, points, timeline: Array.from({ length: points }, (_, i) => ({ minutes: 555 + i })) };
    if (p.startsWith("/api/scorecard?date=")) return noSession ? { ok: true, noSession: true, reason: "weekend" } : { ok: true, authenticated: authed, finalisedAt: finalised ? "2026-11-19T10:08:04Z" : null, events: [{ id: "a" }, { id: "b" }], seriesPoints: 386, dataQuality: { coveragePct: 100 } };
    if (p.startsWith("/api/tv-webhook?date=")) return { signals: [1, 2] };
    return null;
  };
  return { get, calls };
}

test("a finished session: scorecard, raw timeline, signals and swing saved, gzip readable, manifest complete", async () => {
  const out = tmp();
  const api = fakeApi();
  const s = await exportDay({ out, date: "2026-11-19", get: api.get, nowMs: at("2026-11-20", 16, 0), swingDays: [{ date: "2026-11-19", spot: { close: 25514.3 } }] });
  assert.match(s, /saved \(3 timeline points, 2 events\)/);
  const dir = dayDir(out, "2026-11-19");
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, "timeline.json.gz")))).length, 3);
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, "scorecard.json.gz")))).seriesPoints, 386);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "swing.json"))).spot.close, 25514.3);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  assert.equal(m.complete, true);
  assert.ok(api.calls.filter(([p]) => p.startsWith("/api/scorecard")).every(([, auth]) => auth), "scorecard reads authenticated");
  assert.equal(await exportDay({ out, date: "2026-11-19", get: api.get, nowMs: at("2026-11-20", 16, 0) }), "already complete");
});

test("not finalised → nothing written; secret rejected → nothing written; no session → marker", async () => {
  const out = tmp();
  assert.equal(await exportDay({ out, date: "2026-11-19", get: fakeApi({ finalised: false }).get, nowMs: at("2026-11-19", 16, 0) }), "not finalised yet");
  assert.equal(fs.existsSync(dayDir(out, "2026-11-19")), false);
  assert.match(await exportDay({ out, date: "2026-11-19", get: fakeApi({ authed: false }).get, nowMs: at("2026-11-20", 16, 0) }), /secret rejected/);
  assert.equal(await exportDay({ out, date: "2026-11-14", get: fakeApi({ noSession: true }).get, nowMs: at("2026-11-20", 16, 0) }), "no session");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dayDir(out, "2026-11-14"), "manifest.json"))).complete, true);
});

test("a missing raw timeline is retried while it can still exist in Redis, then accepted as gone", async () => {
  const out = tmp();
  const s1 = await exportDay({ out, date: "2026-11-19", get: fakeApi({ points: 0 }).get, nowMs: at("2026-11-20", 16, 0) });
  assert.match(s1, /partially/);
  const s2 = await exportDay({ out, date: "2026-11-19", get: fakeApi({ points: 0 }).get, nowMs: at("2026-12-04", 16, 0) });
  assert.match(s2, /saved/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dayDir(out, "2026-11-19"), "manifest.json"))).timelineMissing, true);
});

test("run: latest snapshots and the index", async () => {
  const out = tmp();
  const api = fakeApi();
  const fetchImpl = async (url) => {
    const p = url.replace("https://x", "");
    if (p === "/api/swing?days=60") return { ok: true, json: async () => ({ ok: true, days: [{ date: "2026-11-19" }] }) };
    if (p === "/api/scorecard?days=180") return { ok: true, json: async () => ({ ok: true, sessions: 8 }) };
    if (p === "/api/tv-webhook?export=csv") return { ok: true, text: async () => "Timestamp\n" };
    return { ok: true, json: async () => api.get(p, {}) };
  };
  const r = await runExport({ out, base: "https://x", secret: "s", nowMs: at("2026-11-20", 12, 0), days: 3, fetchImpl, log: () => {} });
  assert.equal(r.failed, 0);
  const idx = JSON.parse(fs.readFileSync(path.join(out, "index.json")));
  assert.deepEqual(idx.days.map((d) => d.date), ["2026-11-18", "2026-11-19"]);
  assert.ok(fs.existsSync(path.join(out, "latest", "signals-master.csv")));
  assert.ok(fs.existsSync(path.join(out, "latest", "weekly-outlook.json")));
  assert.ok(fs.existsSync(path.join(out, "latest", "scorecard-rolling-180d.json")));
});

test("API: the raw timeline needs the secret", async () => {
  const prev = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = "arch-secret";
  try {
    const store = { get: async () => null, set: async () => true, mget: async (ks) => ks.map(() => null), lrange: async () => [], setNx: async () => true, del: async () => 1 };
    const h = createScorecardHandler({ store, now: () => Date.UTC(2026, 10, 20, 12, 0), getTimeline: async () => [{ minutes: 555, spot: 1 }], settings: () => ({}), send: async () => true });
    const call = async (query) => { const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, end() { return this; } }; await h({ method: "GET", query, headers: {} }, res); return res; };
    assert.equal((await call({ date: "2026-11-19", timeline: "1" })).statusCode, 401);
    const ok = await call({ date: "2026-11-19", timeline: "1", key: "arch-secret" });
    assert.equal(ok.body.points, 1);
  } finally {
    if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev;
  }
});
