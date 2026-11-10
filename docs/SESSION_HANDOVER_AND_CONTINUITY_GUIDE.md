# 🚀 Session Handover & Continuity Guide
## Seamless Transition & Quickstart for Secondary Laptop / New Environment

> **Author**: Antigravity Quantitative Engineering  
> **Repository**: `https://github.com/cskchankrish/OptionsScanner.git`  
> **Branch**: `main`

---

## 1. Quickstart on Your New Laptop

### Step 1: Clone or Pull the Latest Repository
Open PowerShell or your preferred terminal on your new laptop:
```bash
# If cloning for the first time:
git clone https://github.com/cskchankrish/OptionsScanner.git
cd OptionsScanner

# If the repository is already cloned:
git checkout main
git pull origin main
```

### Step 2: Install Dependencies & Run Verification
```bash
# Install node dependencies
npm install

# Run the complete test suite (72/72 tests must pass)
npm test

# Verify Pine Script syntax balance
node test/check_pine_syntax.cjs
```

---

## 2. Environment Variables Checklist (`.env.local`)

Ensure the following environment variables are present in your local `.env.local` or in Vercel project settings:

```env
# Upstash Redis Connection (for active trade state and historical EOD/timeline persistence)
UPSTASH_REDIS_REST_URL="https://your-upstash-redis-url.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-upstash-token"

# Telegram Notification Bot
TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
TELEGRAM_CHAT_ID="your-telegram-chat-or-channel-id"

# TradingView Webhook Secret Authentication
TV_WEBHOOK_SECRET="your-secret-token"

# App Base URL
APP_URL="https://your-app.vercel.app"
```

To test backend connectivity:
```bash
# Test Upstash Redis and Webhook endpoint
curl -X GET "https://your-app.vercel.app/api/tv-webhook?action=status"
# Expected Response: {"status":"ok","activeTrade":null,"message":"FLAT_NO_ACTIVE_TRADES"}
```

---

## 3. TradingView Pine Script & Alert Configuration

### Active Script Files in Repo:
- **Indicator**: [`strategy_dashboard_v4_3_real_oi.pine`](file:///c:/Users/babu6/Chan%20Projects/OptionsScanner/strategy_dashboard_v4_3_real_oi.pine)
- **Strategy / Backtest Ledger**: [`strategy_dashboard_v4_4_backtest_strategy.pine`](file:///c:/Users/babu6/Chan%20Projects/OptionsScanner/strategy_dashboard_v4_4_backtest_strategy.pine)

### Alert Setup in TradingView:
You should have **two separate alerts** configured in TradingView:
1. **15m Chart Alert** (for Intraday Traps & Intraday Synergy).
2. **125m Chart Alert** (for Multi-Day Swings & STBT/BTST Synergy).

#### Alert Settings:
- **Condition**: Select `Strategy Dashboard v4.3 (Real OI + Synergy)` $\to$ `Any alert() function call`.
- **Frequency**: `Once Per Bar Close` (`alert.freq_once_per_bar_close`).
- **Webhook URL**: `https://your-app.vercel.app/api/tv-webhook`
- **Message Body**: Leave as default `{{strategy.order.alert_message}}` or `{{plot_0}}` (Pine script builds the exact JSON dynamically with authentication token included).

---

## 4. Frozen Baseline Reference

The system has a frozen audit baseline established on Nov 9, 2026:
- **Baseline Document**: [`docs/frozen_baseline_nov9_2026.md`](file:///c:/Users/babu6/Chan%20Projects/OptionsScanner/docs/frozen_baseline_nov9_2026.md)
- **Screenshots**: [`docs/images/baseline_15m.png`](file:///c:/Users/babu6/Chan%20Projects/OptionsScanner/docs/images/baseline_15m.png), [`docs/images/baseline_125m.png`](file:///c:/Users/babu6/Chan%20Projects/OptionsScanner/docs/images/baseline_125m.png), [`docs/images/baseline_1d.png`](file:///c:/Users/babu6/Chan%20Projects/OptionsScanner/docs/images/baseline_1d.png)
- **Rules**:
  - `eliminateBaseBreakout` must default to `false` (OFF) for frozen baseline compliance.
  - 15m is the **only operational timeframe** with statistically validated positive edge (+6.6 pts/trade net expectancy, 1.15 Profit Factor, 47.3% net win rate).
  - 125m and Daily are positional regimes and require external 22-strike Option Chain confirmation.

---

## 5. Instant AI Handover Prompt

When you start a new conversation with Antigravity or any AI coding assistant on your other laptop, **copy and paste the prompt below** to restore 100% context instantly:

```markdown
Hello Antigravity. I am continuing work on the OptionsScanner project from my other laptop.

Please read the following documents in the repository to establish full context:
1. `docs/SYSTEM_ARCHITECTURE_AND_MATHEMATICAL_SPECIFICATION.md` - Complete architecture, formulas, and state machines.
2. `docs/CONVERSATION_HISTORY_AND_AUDIT_LOG.md` - Full back-and-forth record, audits conducted, and recent bug fixes.
3. `docs/frozen_baseline_nov9_2026.md` - Official frozen performance baseline.
4. `docs/SESSION_HANDOVER_AND_CONTINUITY_GUIDE.md` - Setup and configuration guide.

Current Project Status:
- Pine Scripts: `strategy_dashboard_v4_3_real_oi.pine` and `strategy_dashboard_v4_4_backtest_strategy.pine` (100% syntax and delimiter verified).
- Backend Engine: `api/tv-webhook.js` with independent 22-strike Option Chain verification for Synergy signals, dynamic Redis TTL (7 days for 125m swings), and corrected exit prioritization.
- Test Suite: 72/72 tests passing (`npm test`).
- Baseline Rule: `eliminateBaseBreakout` defaults to false to maintain frozen baseline metrics.

Please confirm you have reviewed the documentation, check the current repository status, and let me know when you are ready to assist.
```
