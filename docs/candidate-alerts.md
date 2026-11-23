# Candidate alerts (shadow, no orders)

## What they are

The TradingView indicator cannot see the option chain. In Auto mode its "put/call writing blitz" is
a guess from the futures premium. When that guess is wrong, the Synergy or Trap alert is never sent,
so the scanner (which has the real 22-strike chain) never gets to check it.

Indicator **v4.3.1** (`strategy_dashboard_v4_3_1_candidates.pine`) also sends a **candidate** when
the chart and futures conditions hold *without* the option-writing guess. The scanner asks its
normal rules what the real alert would have got against the live option chain, and **only records
the answer**.

Candidates **never place an order, never open or block a trade, and never appear in the normal
signal log** (`latest_signal`, the daily signals list, the master archive). Their only outbound
effect is one clearly labelled **shadow Telegram** per verdict (see below; switch
`CANDIDATE_TELEGRAM_ENABLED`).

## The four grades

| Candidate grade | Real grade it is judged as | Sent when (chart side only) |
|---|---|---|
| `SYNERGY_BULL_CAND` | `SYNERGY_BULL` | futures quadrant is LONG BUILDUP |
| `SYNERGY_BEAR_CAND` | `SYNERGY_BEAR` | futures quadrant is SHORT BUILDUP |
| `BEAR_TRAP_BUY_CAND` | `BEAR_TRAP_BUY` | bear-trap price action, not against a strong downtrend (unless a confirmed swing bottom) |
| `BULL_TRAP_SELL_CAND` | `BULL_TRAP_SELL` | bull-trap price action, not against a strong uptrend (unless a confirmed swing top) |

Each fires once when its condition starts (rising edge), at most once every 4 bars per grade
(input "Shadow Candidate Cooldown"), and never on a bar where the real alert of the same kind fires.

## The four verdicts

- **CONFIRMED** — the real option chain backs it. Synergy: the real alert would be
  `EXECUTE_HIGH_CONVICTION_SYNERGY`. Trap: the real alert would be `EXECUTE_TIER1_SCOUT` with put
  writing (bear trap) or call writing (bull trap) in the trade's favour *and* price within 80 points
  of the floor/roof — the same case that sizes a real trap at 2 lots.
- **UNCONFIRMED** — today's rules would let it through, but the chain does not positively back it
  (moderate synergy, scalp-only downgrade, 1-lot trap).
- **REJECTED** — the real chain vetoes it (any `VETO_*` decision).
- **UNVERIFIABLE** — no live snapshot, a snapshot older than `FLOW_MAX_AGE_SEC`, or no numeric ΔPCR.
  Candidates never trigger an on-demand NSE refresh.

## Where to see them

- **Scorecard tab**: section "Candidate alerts — real-chain verdict (shadow, no orders)", split by
  verdict and by grade. Each candidate is measured with exactly the same rule as real TradingView
  signals: futures-equivalent T1 reached before the stop, within the same session.
- **GET `/api/tv-webhook`**: the `candidates` field lists the day's candidates, newest first
  (stored in `nifty:tv:candidates:<date>`, last 200, kept 14 days).

- **Telegram, per candidate**: one message per verdict. It can never be read as a trade: the
  first line always starts with 🧪 SHADOW CANDIDATE and ends with "no order placed".

  | Verdict | First line |
  |---|---|
  | CONFIRMED | `🧪 SHADOW CANDIDATE · CONFIRMED · SYNERGY_BULL (LONG) — no order placed` |
  | UNCONFIRMED | `🧪 SHADOW CANDIDATE · UNCONFIRMED · <real grade> (<direction>) — no order placed` |
  | REJECTED | `🧪 SHADOW CANDIDATE · REJECTED · <real grade> (<direction>) — no order placed` |
  | UNVERIFIABLE | `🧪 SHADOW CANDIDATE · UNVERIFIABLE · <real grade> (<direction>) — no order placed` |

  The body gives the candidate grade and chart time; entry, stop, T1 and T2; the verdict in plain
  words (confirmed: the real decision it would have got; unconfirmed: what was missing, from the
  stored reasoning; rejected: the veto and why; unverifiable: "Could not judge", saying whether the
  snapshot was missing, too old (with its age and the limit) or had no ΔPCR); ΔPCR, floor and roof;
  the scanner's futures quadrant against the chart's; the snapshot source and age. It ends
  "Shadow only: not sent to the Algo; outcome will appear in the scorecard."
- **Telegram, daily scorecard**: the existing end-of-day scorecard message gets a "Candidates"
  block with one line per candidate: time, grade, direction, verdict and its outcome (T1 first /
  stop first / neither by the close / unmeasurable with the reason). At most 25 lines, then
  "… N more". Outcomes are the scorecard's own (same rule as real signals, unchanged). There is no
  separate per-candidate outcome message.

### When and how the verdict message is sent

1. The candidate is judged, its record is stored in `nifty:tv:candidates:<date>` and its scorecard
   event is recorded, exactly as before.
2. Only then does the send start. It is **never awaited before the reply to TradingView**:
   - on Vercel with a confirmed `waitUntil` (the same check the TradingView ack deadline uses), the
     send is handed to `waitUntil` and the 200 `CANDIDATE_SHADOW` reply goes out immediately;
   - without a confirmed `waitUntil`, the reply is written first and the send is awaited afterwards.
   Candidates do not go through the 2-second ack-deadline wrapper at all: they answer on their own
   (after a Redis read and the record writes), well inside it.
3. **Exactly once**: before sending, an atomic `SET NX` claims
   `nifty:tv:candidate_tg:<date>:<grade>:<bar>` (kept 3 days). `<bar>` is `t=<time>` when the alert
   carries a `t` field; Pine v4.3.1 sends none, so it is a digest of the alert's bar fields (symbol,
   timeframe, direction, close, stop, signal count). A TradingView re-delivery or a concurrent
   invocation finds the claim taken and sends nothing. No Redis, or a failed claim → no message.
4. **Failures**: a Telegram failure, error or hang (capped at 5 s) is logged and nothing else. The
   claim is kept, so there is no retry and no retry storm. The stored verdict, the scorecard event
   and the reply to TradingView are unaffected.

Re-deliveries are still *recorded* twice in the candidate list, as before; only the message is
deduplicated.

## How to read them

After 20–30 sessions, compare the hit rate of **CONFIRMED** candidates with the hit rate of the real
**SIGNAL → APPROVED** rows. If CONFIRMED is about as good (overlapping 95% ranges, enough samples —
not "too few to judge"), the indicator's writing guess is costing trades and candidates are worth
promoting. If CONFIRMED is clearly worse, keep them shadow-only. UNCONFIRMED and REJECTED show what
the chain's filtering is worth.

## Switching off

- Scanner: set `CANDIDATE_SHADOW_ENABLED=false` (or `0`). Candidates are then answered
  `CANDIDATE_IGNORED` and nothing is recorded or sent.
- Telegram only: set `CANDIDATE_TELEGRAM_ENABLED=false` (or `0`; default on). Candidates are then
  judged and recorded exactly as before, with no verdict message, no dedupe key and no "Candidates"
  block in the daily scorecard Telegram.
- Indicator: untick "Send shadow candidate alerts (no orders)".

## Install (owner)

1. TradingView → Pine Editor → open a new indicator, paste the whole of
   `strategy_dashboard_v4_3_1_candidates.pine`, save.
2. Add it to the chart and set the **same inputs** as the current v4.3 indicator (webhook secret,
   tickers, modes). Remove the old v4.3 indicator from the chart.
3. **Delete the old alert** and create a new one on the v4.3.1 indicator: condition
   **"Any alert() function call"**, same webhook URL, same message. An existing alert keeps running the
   old script version, so editing it is not enough.
4. The JSON now carries `"v":"4.3.1"` (the scanner does not check this field).

## Roll back

Either untick "Send shadow candidate alerts (no orders)" on v4.3.1, or re-add the v4.3 indicator
(`strategy_dashboard_v4_3_real_oi.pine`, unchanged) and recreate its alert the same way (delete,
then "Any alert() function call" with the same URL and message).

## Paper ledger (added 23-Nov-2026)

Confirmed candidates are paper-traded **as if they were real signals**, so they can earn — or fail
to earn — a switch to live. Code: `src/candidatePaper.js`; tests: `test/candidatePaper.test.js`;
shown on the Scorecard tab ("Candidate paper trades") and in the daily scorecard Telegram. Paper
only: nothing claims the trade slot, reaches the Algo or places an order.

Why: on 23-Nov-2026 NIFTY fell ~625 points while the indicator's Auto-mode call-writing proxy (the
futures basis) stayed off all day, so the real `SYNERGY_BEAR` never fired during the move. The
`SYNERGY_BEAR_CAND` at 11:20 was CONFIRMED by the real chain (ΔPCR 0.35) but only logged.

| Rule | Default | Env |
|---|---|---|
| Which candidates | `SYNERGY_BULL_CAND`, `SYNERGY_BEAR_CAND` | `CAND_PAPER_GRADES` |
| Which verdicts | CONFIRMED | `CAND_PAPER_CATEGORIES` |
| Stop limit (the Algo's flow `max_r_pts`) | 120 pts from entry | `CAND_PAPER_MAX_R_PTS` |
| Positions | one at a time (a candidate while a paper position is open is skipped) | — |
| Management | the exit-rule shadow's BASELINE path: NIFTY futures (spot levels shifted by the basis at entry), minute fills, stop before target in the same minute, T1 → stop to entry, T2, 15:36 square-off | — |
| Go-live check | ≥ 30 trades, net points > 0, profit factor ≥ 1.5, both halves of the record positive | `CAND_PAPER_MIN_TRADES`, `CAND_PAPER_MIN_PF` |

**Two tracks.** *As the Algo trades today*: a stop wider than the limit is rejected (shown as "not
taken: stop too wide" with what it would have made). *Stop capped*: the same trade with the stop
pulled in to the limit. Synergy stops come from the Supertrend line, which after a long move can be
far away: the 23-Nov 11:20 candidate had a 226-pt stop — rejected as the Algo trades today; with
the stop capped at 120 it reached T1, moved the stop to entry and was held to the 15:36 square-off
for +270.3 futures points (2.58 R).

The go-live thresholds are starting values. Meeting them is evidence, not a switch: turning
candidates live (and any stop-policy change) stays the owner's decision.

**Statuses.** `TAKEN` (closed: counted), `OPEN` (the series ends before the 15:36 square-off —
today in progress or a feed that stopped: shown marked to market, never counted, and it keeps the
slot), `SKIPPED_STOP_TOO_WIDE`, `SKIPPED_POSITION_OPEN` (a paper position held the slot),
`SKIPPED_REAL_TRADE_OPEN` (an executed real signal held the Algo's single slot), `DUPLICATE_OF_REAL`
(a real signal fired on the same bar and side: it is counted as real, not as paper evidence) and
`UNMEASURABLE`. The running record and its go-live check always use the whole stored history
(180 days), whatever window the Scorecard dropdown shows. Telegram lines put grades and reason codes
in `code` so the legacy-Markdown daily message stays valid.

## Indicator v4.3.2 (23-Nov-2026): proxy fixes

`strategy_dashboard_v4_3_1_candidates.pine` (file name kept; title, short title and payload `v` are
now 4.3.2). Found by running the script's own futures/basis block on TradingView for 19–23 Nov:

| Problem | Effect | Fix |
|---|---|---|
| Days to expiry came from `syminfo.expiration_date` of the continuous `NIFTY1!`, which TradingView does not provide | DTE was the manual fallback **12 on every bar**, so the expiry-week guards (`isExpiryWeek`, DTE ≤ 4) never switched on and the fair basis assumed 12 days | DTE from the NSE calendar: the monthly F&O expiry is the last Tuesday of the month, moved to the previous trading day on an exchange holiday (input "NSE Weekday Holidays", default 24-Nov-2026, 25-Dec-2026, 26-Jan-2027 — keep it current). Verified on TradingView: 19-Nov 4, 20-Nov 3, 23-Nov 0 (expiry moved from Tue 24-Nov to Mon 23-Nov) |
| The spot index freezes 15:15–15:30 for the closing auction while futures trade | futures − frozen spot looked like a basis move; on 23-Nov a real `SYNERGY_BEAR` fired at 15:22 that the recalculated bars do not reproduce (Algo rejected it: stop 221.7 pts) | Input "Ignore Basis During the 15:15–15:30 Closing-Auction Spot Freeze" (on): a bar that opens inside 15:15–15:30 (the same live and on history), or any live evaluation from 15:16 to 15:30, treats the basis as unavailable (a bar confirming in the 15:15 minute keeps its valid close; on 75m/125m charts the last bar is frozen only for evaluations after 15:15). Verified on 5m bars: 15:15, 15:20, 15:25 frozen; 15:10, 15:30, 15:35 not for every basis-derived proxy (put/call writing, basis expanding up/down, fresh participation, proxy OI, trap flows). Displayed values are unchanged |

What this does **not** change: in Auto mode the call-writing proxy still needs the futures basis to
fall, and with the correct DTE it is now off for the whole expiry week (DTE ≤ 4), so a real
`SYNERGY_BEAR` cannot fire on those days — on 23-Nov it would still have stayed silent, now for a
stated reason. Those days are covered by the shadow candidates and their paper ledger (above). Side
effect checked: over ~12 sessions (300 bars) the corrected fair basis changed the put-writing proxy
on 3 bars (16-Nov, DTE 7).

**To use it:** paste the script into TradingView (it is not deployed from this repo) and recreate
the alerts, since an alert stays bound to the script version it was created with. Set the webhook
secret in the alert yourself.
