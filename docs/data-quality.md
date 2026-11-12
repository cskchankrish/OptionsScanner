# Data quality, collector status and the Turn Tracker (12-Nov-2026)

On 12-Nov the every-minute poller stopped at 11:38. The afternoon ran on 1–5 browser ticks per 15
minutes, and nothing alerted the owner. The 30-minute radar, the closing flow and the EOD verdict
were all read across the holes. The rule since then: **no history-based conclusion is shown on
missing data without saying so.**

## Thresholds (`src/dataQuality.js`)

| Constant | Value | Meaning |
|---|---|---|
| `DQ_GAP_LIST_MIN` | 3 min | Gaps this long or longer are listed, and the session state becomes `GAPS`. One missed tick is normal scheduler jitter; two in a row is not. |
| `DQ_GAP_ALERT_MIN` | 5 min | A closed gap this long or longer sends one Telegram, "scanner missed ticks hh:mm–hh:mm". |
| `DQ_WINDOW_MAX_GAP_MIN` | 4 min | A window is covered only if its largest hole, edges included, is at most 4 min (up to three missed ticks in a row). |
| `DQ_WINDOW_MIN_COVERAGE_PCT` | 70 % | …and it holds at least 70 % of its expected one-per-minute ticks. |
| `DQ_STALE_AFTER_SEC` | 180 s | During the session, a snapshot older than this is `STALE`. Same default as the blind watchdog. |
| `DQ_BUILDING_MIN_*` | 10 min / 5 ticks | Below these, the state is `BUILDING`. |

`payload.dataQuality` and the `/api/poll` response carry:
- `state`: `OK`, `GAPS`, `STALE` or `BUILDING`;
- coverage since 09:15 and the list of gaps;
- `panels`: the coverage verdict of each history-based panel.

When a window fails, the panel says `not enough data for <window> (n of m expected ticks; gap
hh:mm–hh:mm)` instead of concluding.

## What checks its own window

| Reading | When its window is not covered |
|---|---|
| 30-min radar | `INSUFFICIENT_DATA`, no reading |
| Rolling 30-min futures quadrant | unavailable; fusion falls back to the whole-day quadrant, as before |
| Closing flow and last-hour delta (EOD group B) | `UNVERIFIED`, 0 pts, no late veto |
| Futures stale or missing (EOD group C) | `UNVERIFIED`, 0 pts |
| Floor/roof migration | labelled as compared across a data gap |
| Turn Tracker | no stage; "not enough data since hh:mm" |
| Carry dispatcher | refuses while any scored EOD group is `UNVERIFIED`, and the 15:38 message says so |

When a group is UNVERIFIED, the EOD verdict carries a data caveat.

## Collection

- **Timeline merge.** Every refresh merges the shared Redis timeline by minute. The poller,
  browser and webhook run as separate function instances, and each one used to overwrite the
  others' ticks.
- **Placeholder ticks.** The placeholder canonical timeline is marked `synthetic` and never counts
  as data.
- **Several pollers.** `/api/poll` returns `FRESH_ENOUGH` without calling NSE when a snapshot
  younger than `POLL_MIN_INTERVAL_SEC` (20 s) exists. It records each source's last success and
  failure, and keeps the last 100 failures and the last 100 successes.
- **`GET /api/collector-status`.** The public view is a coarse summary:
  `{ state, snapshotAgeSec, lastTickTime, ticksToday, expectedTicks, coveragePct, maxGapMin, gaps, lastOkBySource }`.
  With the webhook secret it also returns the failure and success lists, each source's records,
  the heartbeat and the poller-down flag.
- **Browser and webhook refreshes.** These check the poller heartbeat. If it is older than
  `POLLER_DOWN_ALERT_SEC` (180 s), one "POLLER DOWN" alert is sent per outage. The next successful
  poll sends "POLLER RECOVERED".

## Turn Tracker (`src/turnTracker.js`, `payload.turnTracker`)

**Display and Telegram only.** `futures.quadrant`, the fusion scenario, the webhook's
validation, vetoes and sizing, the EOD scoring and the carry dispatcher are all unchanged.

The tracker measures from the session's futures swing extreme. It reports a **futures leg** (price,
combined OI and the quadrant they imply) and an **options leg** (put and call writing with the
two-leg decomposition, ΔPCR at the extreme versus now, and floor/roof migration).

| Threshold | Default | Env |
|---|---|---|
| Price noise band | 0.15 % | `TURN_NOISE_PCT` |
| OI noise | 0.10 % | `TURN_OI_NOISE_PCT` |
| Options leg minimum (net, WRITING-driven) | 20,000 | `TURN_OPTIONS_MIN_NET` |
| Confirm: price / OI / elapsed | 0.35 % / 0.5 % / 20 min | `REVERSAL_MIN_MOVE_PCT`, `REVERSAL_MIN_OI_PCT`, `REVERSAL_MIN_ELAPSED_MIN` |

Stages:
- **NO TURN:** neither leg has moved past noise.
- **EARLY:** one leg has turned.
- **LIKELY TURN:** both legs have turned, but the move is below the full thresholds.
- **CONFIRMED:** the full thresholds are met.

Telegram is sent on entering LIKELY TURN and on CONFIRMED, once per (direction, extreme, stage).
It repeats only after a new extreme at least 0.35 % away. Every message says "information only —
not a trade signal and not sent to the Algo".

## EOD verdict card (`src/eodCard.js`)

The card shows, in order:
1. the verdict (`BTST · BUY CE`, `STBT · BUY PE` or `NO CARRY`);
2. the score against its threshold, plus the rule agreement for BTST/STBT only;
3. three evidence rows, each with a contribution and a reason of 12 words or fewer, tagged
   `UNVERIFIED` when relevant;
4. the stop and contract;
5. the carry automation status in plain words;
6. the data row.

The EOD Telegram opens with the same block.
