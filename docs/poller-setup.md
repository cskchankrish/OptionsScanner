# Reliable poller — manual setup (phase 1)

The code ships an authenticated poll endpoint (`/api/poll`), a webhook self-refresh, and a
"scanner blind" Telegram watchdog. None of it is scheduled until you do the steps below by hand.
Nothing here was created automatically: no Vercel settings, GitHub secrets or QStash schedules.

## 1. Vercel environment variables (Project → Settings → Environment Variables, Production)

| Variable | Required | Value |
|---|---|---|
| `TV_WEBHOOK_SECRET` | already set | Unchanged. `/api/poll` accepts it in the `x-webhook-secret` header. |
| `QSTASH_CURRENT_SIGNING_KEY` | yes, for QStash | From the Upstash console → QStash → Signing Keys → Current. |
| `QSTASH_NEXT_SIGNING_KEY` | yes, for QStash | Same page → Next (used during key rotation). |
| `FLOW_BLIND_ALERT_SEC` | optional | Seconds without a fresh snapshot before the "scanner blind" alert. Default `180`. |
| `FLOW_REFRESH_TIMEOUT_MS` | optional | The webhook's on-demand refresh budget. Default `8000`, clamped to 1000–10000. |
| `FLOW_MAX_AGE_SEC` | leave as is | Staleness veto threshold. Default stays `900`. |

The existing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` and Upstash Redis variables are reused.
Redeploy after you change the variables.

## 2. GitHub repository secret (backup cron)

Repo → Settings → Secrets and variables → Actions → New repository secret:

- **Name:** `POLL_SECRET`
- **Value:** the same value as `TV_WEBHOOK_SECRET` in Vercel.

`.github/workflows/market-pulse.yml` sends it as the `x-webhook-secret` header. It never goes in the
URL. Until the secret exists, the workflow fails during market hours with
"POLL_SECRET is not set". GitHub's scheduler is best-effort, so this is only a backup.

## 3. QStash schedule (primary poller)

Upstash console → QStash → Schedules → Create:

- **Destination URL:** `https://niftyninjaa.vercel.app/api/poll`
- **Method:** `POST` (`GET` also works)
- **Body:** leave **empty**. The signature covers a hash of the body, and an empty body hashes the
  same way after Vercel's body parsing.
- **Headers:** none. QStash adds `Upstash-Signature`, and the endpoint verifies it with the
  signing keys above. Do **not** put the webhook secret in the URL.
- **Cron (UTC):** `* 3-10 * * 1-5` (every minute, 08:30–16:29 IST, Mon–Fri). The endpoint does the
  exact gating itself: outside Mon–Fri 09:15–15:40 IST (and Sun 14:00–16:00 IST for Muhurat) it
  returns `200 {"status":"MARKET_CLOSED"}` without touching NSE. If you want fewer wasted calls, use three
  tighter schedules covering 09:14–15:40 IST: `44-59 3 * * 1-5`, `* 4-9 * * 1-5` and
  `0-10 10 * * 1-5`.
  For a Sunday Muhurat session, add a one-off schedule `* 8-10 * * 0` on that day.
- **Retries:** 2 or 3. The endpoint returns 502 when NSE fails and 503 when the Redis write fails,
  so QStash retries real failures and never retries a `MARKET_CLOSED` response.
- **Timeout:** 15s (the Vercel function limit).

## 4. Verify after deploy (read-only checks)

- Call `GET /api/poll` without credentials. Expect `401`, or `503` if `TV_WEBHOOK_SECRET` is unset.
- In QStash → Logs, schedule deliveries should return `200`, with `LIVE_POLL_SUCCESS` in market
  hours and `MARKET_CLOSED` outside them.
- In Upstash Redis, `nifty:poller:last_ok` should hold `{ at, snapshotAt, source: "qstash" }`, and
  `nifty:flow:latest.snapshotSource` should be `"poller"`.
- The Telegram text for an actionable alert now includes an
  `Option-Chain Snapshot: poller · age 42s` line.

## Behaviour summary

- `/api/poll` always bypasses the 5s memory cache and awaits the `nifty:flow:latest` write. A 2xx
  response means the snapshot really was refreshed.
- `/api/tv-webhook` handles an actionable alert (trap or synergy) that arrives with a missing or
  stale snapshot during market hours. It runs one bounded refresh (8s), re-reads the snapshot and
  validates again. It only vetoes with `VETO_STALE_OPTION_CHAIN` if that refresh fails, times out,
  or still leaves the snapshot stale, and the veto text says why.
- Watchdog: when the snapshot is older than `FLOW_BLIND_ALERT_SEC` during market hours, it sends one
  "SCANNER BLIND" Telegram message per outage. The dedupe key is `nifty:watchdog:blind`, set with
  `SET NX`. When a fresh snapshot arrives it sends one "SCANNER RECOVERED" message. The first
  `FLOW_BLIND_ALERT_SEC` after session open are a grace period.
- The old unauthenticated `/api/nifty-oi?cron=1` ping still works unchanged.
