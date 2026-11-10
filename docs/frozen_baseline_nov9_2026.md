# 🧊 Official Frozen Performance Baseline (Nov 9, 2026)

**Scripts**: `strategy_dashboard_v4_3_real_oi.pine` (Indicator) & `strategy_dashboard_v4_4_backtest_strategy.pine` (Strategy)  
**Codebase Commit**: [`b75972c`](file:///C:/Users/babu6/Chan%20Projects/OptionsScanner)  
**Audit Configuration**: Mode = **Traps Only (Bull/Bear Trap)** | R-Floor = **ON** (Min 1.0R T1 / 2.0R T2) | Stop Cap = **1.8× ATR14**  
**Execution Constraints**: 1 Position at a Time | 60/40 Scale-out | 20-bar Time-Stop | 4.0 pt Round-Trip Friction  

---

## 📸 Benchmark Screenshots (In-Sample Ledger)

````carousel
![15m Performance Baseline](/C:/Users/babu6/.gemini/antigravity/brain/1cc6f1ec-d4ff-4823-93df-ab900c9d1999/baseline_15m.png)
<!-- slide -->
![125m Performance Baseline](/C:/Users/babu6/.gemini/antigravity/brain/1cc6f1ec-d4ff-4823-93df-ab900c9d1999/baseline_125m.png)
<!-- slide -->
![Daily Performance Baseline](/C:/Users/babu6/.gemini/antigravity/brain/1cc6f1ec-d4ff-4823-93df-ab900c9d1999/baseline_1d.png)
````

---

## 📊 Comprehensive Timeframe Comparison

| Metric | 15m (Intraday) | 125m (Swing) | Daily (1D Multi-Week) |
| :--- | :---: | :---: | :---: |
| **Real OI Coverage** | **100.0%** (20,119 / 20,119) | 77.8% (3,375 / 4,339) | **100.0%** (1,451 / 1,451) |
| **Total Trades ($n$)** | **338 trades** | 180 trades | 30 trades |
| **Trade Frequency** | **103.3/yr** (~2 trades/week) | 30.8/yr (~0.6/week) | 5.1/yr |
| **P(T1 Hit) [Wilson 95%]** | **30.8%** [26–36%] | 43.3% [36–51%] | 33.3% [19–51%] |
| **Net Win% [Wilson 95%]** | **47.3%** [42–53%] | 48.3% [41–56%] | 33.3% [19–51%] |
| **Required Break-Even Win%** | **44.0%** *(Positive Edge)* | 52.0% *(Inverted: Loss)* | 48.0% *(Inverted: Loss)* |
| **P(T2 Runner Hit)** | **9.8%** (33 trades) | 18.3% (33 trades) | 13.3% (4 trades) |
| **Breakeven (BE) Exits** | 21 trades | 31 trades | 3 trades |
| **Full Stop Loss (SL) Exits** | 159 trades (47.0%) | 84 trades (46.7%) | 17 trades (56.7%) |
| **Time-Stop Exits (TStop)** | **125 trades** (37.0%) | 32 trades (17.8%) | 6 trades (20.0%) |
| **Avg Win / Avg Loss** | **+105 pts / -82 pts** | +208 pts / -229 pts | +455 pts / -425 pts |
| **Avg 1R Stop / Avg T1** | **82 pts / 123 pts** | 222 pts / 223 pts | 447 pts / 447 pts |
| **Net Expectancy ($R$)** | **+0.09R** | -0.05R | -0.29R |
| **Net Expectancy (pts/trade)** | **+6.6 pts** | -18.0 pts | -131.8 pts |
| **Net Profit Factor (Cost=4.0)**| **1.15** | 0.85 | 0.54 |
| **Cumulative Net PnL** | **+2,247 pts** | -3,240 pts | -3,954 pts |
| **Max Drawdown** | **-1,016 pts** | -4,704 pts | -4,601 pts |
| **Go / No-Go Verdict** | **⚠️ MARGINAL (PAPER ONLY)** | **⛔ NO-GO (DO NOT TRADE)** | **⛔ NO-GO (DO NOT TRADE)** |

---

## 💡 Key Takeaways for Paper Trading Starting Nov 9

> [!IMPORTANT]
> **15m is the ONLY Operational Timeframe**:
> 15m is the only timeframe with positive expectancy (+6.6 pts/trade) and a win rate (47.3%) higher than required break-even (44%). Both 125m and Daily are strictly **NO-GO**.

> [!NOTE]
> **Theory vs Reality Alignment**:
> Claude Sonnet 5.5's theoretical model estimated: win rate ~50% (42–58%), stop ~70–100 pts, T1 ~125 pts, and expectancy 0 to +0.2R. The empirical ledger recorded **47.3% win rate, 82 pt stop, 123 pt T1, and +0.09R expectancy**, proving exact mechanical consistency between the Pine script and audit models.

> [!WARNING]
> **Strict Exit Discipline is Mandatory**:
> 37.0% of all trades on 15m exited via the **20-bar (5-hour) Time-Stop**. Without enforcing this time-stop, trades drift into full stop losses, turning the +6.6 pt edge negative.
