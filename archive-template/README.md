# NIFTY data archive (private)

Written automatically by `.github/workflows/archive.yml` from the OptionsScanner API. Do not edit by hand.

| Path | What |
|---|---|
| `days/YYYY-MM/YYYY-MM-DD/scorecard.json.gz` | Scorecard day: every event (signals, candidates, Turn Tracker, radar, EOD, trades with ₹), outcomes, compact per-minute series (`m` minute, `f` futures, `o` combined futures OI, `v` cumulative futures volume, `s` spot, `p` put writing, `c` call writing) |
| `days/.../timeline.json.gz` | Raw per-minute timeline as recorded by the poller |
| `days/.../signals.json.gz` | TradingView signals and trade results of the day |
| `days/.../swing.json` | Daily swing summary (Weekly Outlook input) |
| `days/.../manifest.json` | What was saved and whether the session is complete |
| `latest/` | Rolling snapshots, overwritten each run (git history keeps the old ones) |
| `index.json` | Every archived date |

Read a file in Node: `JSON.parse(zlib.gunzipSync(fs.readFileSync(path)))`.
In Python: `json.load(gzip.open(path))`.

Setup: repository secret `ARCHIVE_SECRET` = the Vercel `TV_WEBHOOK_SECRET` value.
Run now: Actions → Daily data archive → Run workflow.
