# Data archive

Redis (Upstash) is short-term storage:

| Data | Redis retention |
|---|---|
| Raw per-minute timeline (`nifty_timeline_v2_<date>`) | 14 days |
| Scorecard day (`nifty:sc:day:<date>`, events + compact minute series) | 180 days |
| Swing day summaries (`nifty:swing:day:<date>`) | 400 days (`SWING_RETENTION_DAYS`) |
| EOD history | 90 days |
| Candidates, execution updates | 14 days |
| TradingView signal archive | last 1,000 signals |

The long-term copy lives in a **private** GitHub repo (this repo is public, so the data never goes
here). `scripts/archive-export.mjs` reads the API (read-only) and writes one folder per session;
the private repo's workflow (template in `archive-template/`) runs it every weekday evening and
commits the result. Each run back-fills the last 12 days, so a dropped scheduled run is harmless.

The raw timeline is read through `GET /api/scorecard?date=…&timeline=1` (authenticated).

Setup (once):
1. Create the private repo and push `archive-template/` into it.
2. Add the repository secret `ARCHIVE_SECRET` (the Vercel `TV_WEBHOOK_SECRET` value).
3. Actions → Daily data archive → Run workflow, then check `index.json`.

Size: about 0.1–0.5 MB per session compressed, roughly 50 MB for six months.
