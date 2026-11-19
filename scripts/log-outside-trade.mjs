#!/usr/bin/env node
/**
 * Log a trade you took OUTSIDE the system, for the override-cost tracker (src/overrideCost.js).
 *
 *   $env:TV_WEBHOOK_SECRET = "…"   (PowerShell; never commit it)
 *   node scripts/log-outside-trade.mjs --dir SHORT --in 14:00 --out 15:10 --pnl -3200 --what "25400 PE" --note "rejection candle"
 *   node scripts/log-outside-trade.mjs --date 2026-11-19 --delete <id>
 *
 *   --dir    LONG (bought calls / long futures) or SHORT (bought puts / short futures)
 *   --in     entry time HH:MM IST           --out   exit time HH:MM IST (optional)
 *   --pnl    your rupee result before charges (negative for a loss)
 *   --date   YYYY-MM-DD, default today (IST) --base  default https://niftyninjaa.vercel.app
 */
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []));
const base = String(args.base || "https://niftyninjaa.vercel.app").replace(/\/$/, "");
const date = args.date || new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const secret = process.env.TV_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set TV_WEBHOOK_SECRET in the environment first.");
  process.exit(1);
}
const body = args.delete
  ? { action: "outside_trade_delete", date, id: String(args.delete) }
  : { action: "outside_trade", date, trade: { direction: args.dir, entryTime: args.in, exitTime: args.out || null, pnlInr: Number(args.pnl), instrument: args.what || null, note: args.note || null } };
const r = await fetch(`${base}/api/scorecard`, { method: "POST", headers: { "Content-Type": "application/json", "x-webhook-secret": secret }, body: JSON.stringify(body) });
const j = await r.json().catch(() => ({}));
if (!r.ok || !j.ok) {
  console.error(`Failed (${r.status}): ${j.error || "unknown error"}`);
  process.exit(1);
}
console.log(args.delete ? `Removed ${j.removed}.` : `Logged ${j.logged.id} on ${date}.`);
console.log(`${date}: ${j.trades.length} outside trade(s) logged.`);
