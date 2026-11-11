# Flow execution bridge (scanner side, contract v1.1)

The scanner (`api/tv-webhook.js`) can send approved flow signals to the external execution
engine ("the Algo") as signed `FLOW_ENTRY` instructions. The Algo places at most **1 lot**.

In v1.1 the Algo acknowledges at once (`accepted` means validated and queued, **not** filled) and
executes in the background. It then reports the entry outcome (`ENTRY_FILLED` or `ENTRY_FAILED`)
and later the exits, all through sync-back.

### Trade states (`execution.status`)

```
PENDING ──accepted──▶ ACCEPTED ──ENTRY_FILLED──▶ FILLED ──exit sync-back──▶ (closed)
   │                     │  └──ENTRY_FAILED──▶ NOT_EXECUTED (lock released)
   │                     └─ no report > FLOW_BRIDGE_FILL_WAIT_SEC ⇒ one "no fill report" Telegram
   ├──rejected/duplicate──▶ NOT_EXECUTED (lock released)
   └──timeout/5xx/…──▶ UNKNOWN ──ENTRY_FILLED──▶ FILLED   (or ENTRY_FAILED ⇒ NOT_EXECUTED)
```

`PENDING`, `ACCEPTED`, `UNKNOWN` and `FILLED` are **Algo-owned**:
- the auto-lifecycle never touches them;
- exits must carry the matching `tradeId`. Code: `src/flowBridge.js` (dispatcher), wiring in `api/tv-webhook.js`,
tests in `test/flowBridge.test.js`.

## Turning it off instantly

Set `FLOW_BRIDGE_ENABLED=false` (or remove it) in the Vercel env and redeploy/promote. The flag
is read on every request. With the bridge off, the webhook behaves as before: paper trades only,
auto-managed by `evaluateActiveTradeLifecycle`.

Trades that are already bridge-owned stay bridge-owned after the flag is turned off. Clear one
by hand once you have checked the broker:
`GET /api/tv-webhook?close_trade=1&tradeId=<id>&key=<webhook secret>`.

## Environment variables (names only)

| Name | Meaning |
|---|---|
| `FLOW_BRIDGE_ENABLED` | `true` turns the bridge on. Anything else means off. |
| `FLOW_BRIDGE_URL` | The Algo's entry endpoint. Required. |
| `FLOW_BRIDGE_SECRET` | HMAC key shared with the Algo. Required. |
| `FLOW_BRIDGE_DECISIONS` | Comma-separated decision allow-list. Default `EXECUTE_TIER1_SCOUT,EXECUTE_HIGH_CONVICTION_SYNERGY`. |
| `FLOW_BRIDGE_TIMEOUT_MS` | Upper bound for the dispatch call. Default 3000, clamped to 1000..5000. |
| `FLOW_BRIDGE_FILL_WAIT_SEC` | Seconds an `ACCEPTED` trade may wait for ENTRY_FILLED or ENTRY_FAILED before the one-time "no fill report" alert. Default 120. |
| `TV_WEBHOOK_SECRET` | Existing secret. The Algo's sync-back must carry it. |

The bridge is enabled only when the flag is `true` **and** both the URL and the secret are set.

## Entry instruction (scanner → Algo)

`POST {FLOW_BRIDGE_URL}`

```json
{ "v":1, "type":"FLOW_ENTRY", "id":"ft-1762841000000-a1b2c3d4", "ts":1762841000000,
  "grade":"SYNERGY_BEAR", "decision":"EXECUTE_HIGH_CONVICTION_SYNERGY", "dir":"SHORT",
  "spot":24960, "entry":24960, "sl":25025, "t1":24895, "t2":24830, "lots":1, "snapshotAgeSec":20 }
```

- The keys are always in this order. Every price is a NIFTY **spot** level.
- `spot` is the scanner's spot at signal time: the chart's signal close, the same value as
  `entry`. The snapshot's own `spotPrice` is deliberately not used, because it can carry a
  hard-coded fallback.
- `lots` is always `1`, whatever `recommendedLots` says.
- `id` format: `ft-<epoch ms>-<8 hex>`. The same id is stored on the active trade, shown in
  Telegram and returned as `fusedVerdict.tradeId`.
- Headers:
  - `Content-Type: application/json`
  - `X-Flow-Timestamp: <ts>`
  - `X-Flow-Signature: hex(HMAC-SHA256(FLOW_BRIDGE_SECRET, "<ts>.<raw body>"))`, in lowercase.
    The raw body is the exact string sent.
- The scanner dispatches only when all of these hold:
  - the grade is one of `BEAR_TRAP_BUY`, `BULL_TRAP_SELL`, `SYNERGY_BULL`, `SYNERGY_BEAR`;
  - the decision is in the allow-list;
  - the single-position lock was claimed;
  - `entry`, `sl`, `t1`, `t2` are positive numbers and `dir` is LONG or SHORT. Otherwise the
    trade is recorded as `NOT_EXECUTED` ("missing/invalid …") and the lock is released.
- The scanner **never retries automatically**. A manual resend with the same `id` is safe because
  the Algo answers `duplicate`.

### Algo response

HTTP 200 with `{ "status":"accepted"|"rejected"|"duplicate", "reason":…, "mode":"dry_run"|"shadow"|"live", "orderRef":… }`.

| Algo result | Stored `execution` | Lock | Telegram |
|---|---|---|---|
| `accepted` | `{status:"ACCEPTED", mode, orderRef, at, dispatchMs}` | held, normal TTL | "SENT TO ALGO · AWAITING FILL (1 LOT)" (not "executed") |
| `rejected` / `duplicate` | `{status:"NOT_EXECUTED", outcome, reason, mode, orderRef, at}` | **released** | "APPROVED BUT NOT EXECUTED" + reason |
| non-200, timeout, network error, non-JSON, unknown `status` | `{status:"UNKNOWN", error, httpStatus, timeoutMs, at}` | held **with no expiry** | "ALGO OUTCOME UNKNOWN — CHECK YOUR BROKER NOW" |

- `execution` is also written to `fusedVerdict.execution`, so it appears in the signal archive and
  the main alert.
- A `NOT_EXECUTED` trade is removed from `nifty:tv:active_trade`; its record stays in the archive.

## Single-position lock

`nifty:tv:active_trade` is claimed with `SET … NX EX <ttl>` before any dispatch. The TTL is
8 h for intraday trades and 7 d for 125m, daily or synergy trades. Of several concurrent
actionable alerts, exactly one gets `OK`. The others become `BLOCKED_BY_ACTIVE_TRADE`, get no
trade id and send no dispatch.

- When the bridge will dispatch, the claimed record carries `execution.status = "PENDING"`. If
  the function dies mid-dispatch, the trade therefore stays bridge-owned and locked.
- If Redis is not configured or the claim errors, the bridge does **not** dispatch
  (`NOT_EXECUTED`, "position lock unavailable"). Paper trades keep today's lenient behaviour.
- The lock is released with read-check-delete: the key is deleted only if it still holds that
  trade's id. This is not atomic. In the tiny window between the read and the delete, a new claim
  is impossible because the key still exists.

## Trade identity and exit matching

- Every opened trade (paper or bridge) has an `id`.
- An exit POST (`TARGET_1_HIT`, `TARGET_2_HIT`, `BREAKEVEN_STOP`, `STOP_LOSS_HIT`,
  `TIME_STOP_EXIT`, `MANUAL_CLOSE`) that carries `tradeId` must match the active trade's id.
  Otherwise it gets **409** `{ok:false, error:"TRADE_ID_MISMATCH"}`, a log line, and no state
  change.
- A **bridge-owned** trade (`execution.status` PENDING, ACCEPTED, UNKNOWN or FILLED) is exited only by an
  exit with its matching `tradeId`. TradingView exits without a `tradeId` get 409. The same rule
  applies to `GET ?close_trade=1`, which takes `&tradeId=`.
- `evaluateActiveTradeLifecycle` (GET `?spot=` and the `nifty-oi` hook) skips bridge-owned trades
  entirely: no auto T1, SL or T2.
- Paper trades without a `tradeId` in the exit keep the old behaviour.

## Sync-back (Algo → scanner)

`POST /api/tv-webhook`, authenticated with `TV_WEBHOOK_SECRET` through the existing mechanism:
the `x-webhook-secret` header, a `secret` field in the body, or `?key=`.

Final accepted fields:

| Field | Required | Use |
|---|---|---|
| `grade` | yes | One of the six exit grades above |
| `tradeId` | yes for bridge trades | Must equal the `id` from FLOW_ENTRY |
| `spot` | recommended | NIFTY spot at the fill. Used as the exit/fill level |
| `close` | optional alias | Takes precedence over `spot` if both are sent (TradingView's key) |
| `optionFill` | optional | Option premium fill. Stored in `sync`, not used in P&L |
| `lots` | optional | Stored in `sync` |
| `mode` | optional | `dry_run` / `shadow` / `live`. Stored in `sync` |
| `source` | optional | e.g. `"algo"`. Stored in `sync` |
| `t` | optional | Epoch ms. Stored in `sync` |
| `secret` | when not using the header or `?key=` | Webhook auth |

- If neither `close` nor `spot` is given, the fill level falls back to `entry`, then to the
  trade's T1, T2 or entry, as before.
- Exit and T1 archive records carry `sync: {source, tradeId, spot, optionFill, lots, mode, t}`.
- `TARGET_1_HIT` keeps the trade open, sets `hitT1` and moves SL to cost.
- A matching `TARGET_1_HIT` on a `PENDING`, `ACCEPTED` or `UNKNOWN` trade turns it into `FILLED`
  (`resolvedBy:"sync-back"`), since a T1 proves a filled position.

### Entry outcome sync-back (v1.1)

Same endpoint and auth as exits. A `tradeId` matching the open trade is **required**.

| Grade | Body | Valid from | Effect |
|---|---|---|---|
| `ENTRY_FILLED` | `{grade, tradeId, source:"algo", spot, optionFill, contract, lots, mode, t}` | PENDING, ACCEPTED, UNKNOWN | `execution` becomes `{status:"FILLED", previousStatus, optionFill, contract, mode, lots, fillSpot, filledAt}`. `filledAt` comes from `t`, else now. The lock is kept with the trade TTL. The record is archived and Telegram "ENTRY FILLED BY ALGO" is sent with the contract and fill. |
| `ENTRY_FAILED` | `{grade, tradeId, source:"algo", reason, mode, t}` | PENDING, ACCEPTED, UNKNOWN | `execution` becomes `{status:"NOT_EXECUTED", outcome:"ENTRY_FAILED", reason, mode}`. The lock is **released** and a marker `nifty:tv:bridge:failed:<id>` is kept for 7 d. The record is archived and Telegram "APPROVED BUT NOT EXECUTED" is sent with the reason. |

The response is `200 {ok:true, event, tradeId, execution}`. Other cases:

| Situation | Response |
|---|---|
| Repeat `ENTRY_FILLED` on a FILLED trade | 200 `{duplicate:true}`, no change, no Telegram |
| Repeat `ENTRY_FAILED` (failed marker exists) | 200 `{duplicate:true}`, no change, no Telegram |
| Missing `tradeId` | 409 `TRADE_ID_REQUIRED` |
| `tradeId` doesn't match the open trade | 409 `TRADE_ID_MISMATCH` |
| Report on a paper trade | 409 `INVALID_TRANSITION` |
| `ENTRY_FAILED` on a FILLED trade | 409 `CONTRADICTORY_REPORT` + loud Telegram, state unchanged |
| `ENTRY_FILLED` after `ENTRY_FAILED` released the lock | 409 `CONTRADICTORY_REPORT` + loud Telegram ("scanner is NOT tracking this position") |
| Redis not configured or unreadable | 503 `REDIS_UNAVAILABLE` |

### Stuck-ACCEPTED guard

A trade can stay `ACCEPTED` with no ENTRY_FILLED or ENTRY_FAILED for longer than
`FLOW_BRIDGE_FILL_WAIT_SEC` (default 120 s, measured from `execution.at`). When that happens, the
next place that already inspects the open trade sends **one** Telegram, "NO FILL REPORT FROM ALGO —
CHECK THE BROKER". Those places are:
- `evaluateActiveTradeLifecycle`, which runs from the `nifty-oi` refresh and from GET `?spot=`;
- an actionable webhook that is blocked by the trade.

The alert is deduped with `SET NX` on `nifty:tv:bridge:stuck_alert:<id>` (7 d). State is never
changed, and no scheduler was added. The alert fires only when one of those code paths runs.
- Full exits delete the trade.
- P&L is still computed in spot points by the existing formulas.

## Timeout choice

- Vercel caps the function at 15 s.
- Before the dispatch, a request can spend about 1 s on auth and Redis, up to 8 s on the
  on-demand refresh (only when the snapshot is stale), and about 0.5 s on the fusion and the lock
  claim.
- After the dispatch, the work needs about 4 s, reserved as `POST_DISPATCH_RESERVE_MS`:
  - record the outcome in Redis;
  - the bridge Telegram message (3 s client timeout);
  - archive writes;
  - the main alert;
  - the watchdog.
- The dispatch timeout is therefore `min(FLOW_BRIDGE_TIMEOUT_MS (default 3000), 15000 − 4000 − elapsed)`.
  - In the normal case (fresh snapshot, about 1 s elapsed) that is the full 3 s.
  - After a full 8 s refresh it shrinks to about 2 s.
  - If less than 1 s would remain, the scanner does not dispatch at all and records
    `NOT_EXECUTED` ("time budget exhausted"). A known non-execution is safer than a likely
    `UNKNOWN`.
- This fits without changing `vercel.json`.
- The Algo should answer quickly: acknowledge the signal and do the broker work asynchronously.
  Otherwise slow broker calls turn into `UNKNOWN`.

## Failure modes

| Failure | Result |
|---|---|
| Bridge env incomplete | Bridge off; paper behaviour |
| Algo down, slow or returns 5xx | `UNKNOWN`, locked forever, loud Telegram. Check the broker, then close with `tradeId` (or let the Algo sync back) |
| Algo rejects or reports duplicate | `NOT_EXECUTED`, lock released, Telegram with the reason |
| Function killed mid-dispatch | Trade stays `PENDING` (bridge-owned, locked until TTL). No Telegram. Check the broker and the Algo log |
| Redis down at claim | No dispatch; Telegram "NOT EXECUTED (position lock unavailable)" |
| Redis write of the outcome fails | Trade stays `PENDING` and locked; the Telegram message still reports the true outcome |
| Wrong or missing `tradeId` on an exit for a bridge trade | 409, nothing changes |
| A TradingView exit alert while a bridge trade is open | 409 (the Algo owns exits) |

`PENDING` trades keep the claim TTL, unlike `UNKNOWN`. A function killed mid-dispatch therefore
unlocks after 8 h or 7 d.
