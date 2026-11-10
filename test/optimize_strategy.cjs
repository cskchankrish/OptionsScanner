const fs = require('fs');

const dailyBars = JSON.parse(fs.readFileSync('c:/Users/babu6/Chan Projects/OptionsScanner/test/nifty_7y_daily.json', 'utf8'));
const hourlyBars = JSON.parse(fs.readFileSync('c:/Users/babu6/Chan Projects/OptionsScanner/test/nifty_3y_hourly.json', 'utf8'));

function computeEMA(bars, length, sourceFn = b => b.close) {
  const ema = new Array(bars.length);
  const k = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += sourceFn(bars[i]);
  ema[length - 1] = sum / length;
  for (let i = length; i < bars.length; i++) {
    ema[i] = sourceFn(bars[i]) * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function computeATR(bars, period = 14) {
  const atr = new Array(bars.length);
  const tr = new Array(bars.length);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function computeSupertrend(bars, atr, period = 5, multiplier = 3.0) {
  const st = new Array(bars.length);
  const isBull = new Array(bars.length);
  let upperBand = 0, lowerBand = 0, inBull = true;
  for (let i = period; i < bars.length; i++) {
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];
    if (i === period) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      inBull = bars[i].close > basicUpper;
    } else {
      lowerBand = (basicLower > lowerBand || bars[i - 1].close < lowerBand) ? basicLower : lowerBand;
      upperBand = (basicUpper < upperBand || bars[i - 1].close > upperBand) ? basicUpper : upperBand;
      if (inBull && bars[i].close < lowerBand) inBull = false;
      else if (!inBull && bars[i].close > upperBand) inBull = true;
    }
    st[i] = inBull ? lowerBand : upperBand;
    isBull[i] = inBull;
  }
  return { st, isBull };
}

function computeRSI(bars, period = 14) {
  const rsi = new Array(bars.length);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-9))));
  for (let i = period + 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    const rs = avgGain / (avgLoss || 1e-9);
    rsi[i] = 100 - (100 / (1 + rs));
  }
  return rsi;
}

function runDeepOptimization(bars, label, isDaily) {
  const ema13 = computeEMA(bars, 13);
  const ema34 = computeEMA(bars, 34);
  const ema89 = computeEMA(bars, 89);
  const ema200 = computeEMA(bars, 200);
  const d5Ema = computeEMA(bars, 5, b => (b.high + b.low + b.close) / 3);
  const atr14 = computeATR(bars, 14);
  const rsi14 = computeRSI(bars, 14);
  const { isBull: stBull, st: stLine } = computeSupertrend(bars, atr14, 5, 3.0);

  // Test various strategy variations to find what reaches >= 80% Win Rate!
  const variations = [
    {
      id: 'V1_TWO_STAGE_SWING',
      name: 'Variation 1: Two-Stage Structural Turn (Exhaustion + 5-EMA/High Breakout)',
      filter: (i, prevNHi, prevNLo) => {
        const cur = bars[i];
        // 2-stage Bottom: Setup within last 5 bars (RSI < 40 or sweep low) AND structural breakout today:
        let hadOversold = false;
        for (let k = 1; k <= 5; k++) {
          if (rsi14[i - k] < 42 || bars[i - k].low < ema89[i - k]) hadOversold = true;
        }
        const confirmBottom = hadOversold && cur.close > d5Ema[i] && cur.close > prevNHi && cur.close > ema13[i];

        let hadOverbought = false;
        for (let k = 1; k <= 5; k++) {
          if (rsi14[i - k] > 68 || bars[i - k].high > ema89[i - k] * 1.03) hadOverbought = true;
        }
        const confirmTop = hadOverbought && cur.close < d5Ema[i] && cur.close < prevNLo && cur.close < ema13[i];

        if (confirmBottom) return 'LONG';
        if (confirmTop) return 'SHORT';
        return null;
      }
    },
    {
      id: 'V2_HIGH_CONFLUENCE_TREND',
      name: 'Variation 2: High Confluence Trend Alignment (Score >= 6/8)',
      filter: (i) => {
        const cur = bars[i];
        const bullScore = (ema13[i] > ema34[i] ? 1 : 0) +
                          (stBull[i] ? 1 : 0) +
                          (cur.close > d5Ema[i] ? 1 : 0) +
                          (cur.close > ema89[i] ? 1 : 0) +
                          (cur.close > ema200[i] ? 1 : 0) +
                          (rsi14[i] > 52 && rsi14[i] < 68 ? 1 : 0);

        const bearScore = (ema13[i] < ema34[i] ? 1 : 0) +
                          (!stBull[i] ? 1 : 0) +
                          (cur.close < d5Ema[i] ? 1 : 0) +
                          (cur.close < ema89[i] ? 1 : 0) +
                          (cur.close < ema200[i] ? 1 : 0) +
                          (rsi14[i] < 48 && rsi14[i] > 32 ? 1 : 0);

        // Entry on fresh trigger (bullScore becomes >= 5 or bearScore becomes >= 5)
        const prevBull = (ema13[i-1] > ema34[i-1] ? 1 : 0) + (stBull[i-1] ? 1 : 0) + (bars[i-1].close > d5Ema[i-1] ? 1 : 0);
        if (bullScore >= 5 && prevBull < 3) return 'LONG';
        if (bearScore >= 5) return 'SHORT';
        return null;
      }
    },
    {
      id: 'V3_DIP_ABSORPTION_PULLBACK',
      name: 'Variation 3: With-Trend Dip Absorption (Bear Trap Buy in Bull Regime)',
      filter: (i, prevNHi, prevNLo, localTrapLo, localTrapHi) => {
        const cur = bars[i];
        const prev = bars[i - 1];
        const isBullRegime = ema13[i] > ema34[i] && cur.close > ema200[i] && stBull[i];
        const isBearRegime = ema13[i] < ema34[i] && cur.close < ema200[i] && !stBull[i];

        const barRng = Math.max(cur.high - cur.low, 0.05);
        const bullClPos = (cur.close - cur.low) / barRng;
        const bearClPos = (cur.high - cur.close) / barRng;

        // Dip into EMA13 or EMA34 and absorb
        const dipEmaLong = isBullRegime && cur.low <= ema34[i] && cur.close > ema13[i] && bullClPos >= 0.50;
        const rallyEmaShort = isBearRegime && cur.high >= ema34[i] && cur.close < ema13[i] && bearClPos >= 0.50;

        if (dipEmaLong) return 'LONG';
        if (rallyEmaShort) return 'SHORT';
        return null;
      }
    },
    {
      id: 'V4_TWO_TIER_FUSION_OPTIMIZED',
      name: 'Variation 4: Two-Tier Structural Fusion + Scaled Target 1 (T1 = 0.6x ATR / +0.50%, SL = Supertrend / Swing Base)',
      filter: (i, prevNHi, prevNLo, localTrapLo, localTrapHi) => {
        const cur = bars[i];
        const prev = bars[i - 1];
        const isUptrend = ema13[i] > ema34[i] && cur.close > ema89[i];
        const isDowntrend = ema13[i] < ema34[i] && cur.close < ema89[i];

        // Long: Uptrend dip to EMA13/34 + hammer absorption OR Two-Stage breakout
        const longAbs = isUptrend && cur.low <= ema13[i] && cur.close > d5Ema[i] && cur.close > prev.high;
        const shortAbs = isDowntrend && cur.high >= ema13[i] && cur.close < d5Ema[i] && cur.close < prev.low;

        if (longAbs) return 'LONG';
        if (shortAbs) return 'SHORT';
        return null;
      }
    }
  ];

  console.log(`\n========================================================================`);
  console.log(`  OPTIMIZATION COMPARISON: ${label}`);
  console.log(`========================================================================`);

  for (const v of variations) {
    const trades = [];
    let lastTradeBar = -999;
    const cooldown = isDaily ? 3 : 5;

    for (let i = 205; i < bars.length - 15; i++) {
      if (i - lastTradeBar < cooldown) continue;

      let prevNHi = -Infinity, prevNLo = Infinity;
      for (let k = 1; k <= 3; k++) {
        if (bars[i - k].high > prevNHi) prevNHi = bars[i - k].high;
        if (bars[i - k].low < prevNLo) prevNLo = bars[i - k].low;
      }

      let localTrapHi = -Infinity, localTrapLo = Infinity;
      for (let k = 1; k <= (isDaily ? 10 : 20); k++) {
        if (bars[i - k].high > localTrapHi) localTrapHi = bars[i - k].high;
        if (bars[i - k].low < localTrapLo) localTrapLo = bars[i - k].low;
      }

      const sig = v.filter(i, prevNHi, prevNLo, localTrapLo, localTrapHi);
      if (!sig) continue;

      lastTradeBar = i;
      const cur = bars[i];
      const entryPrice = bars[i + 1] ? bars[i + 1].open : cur.close;
      const atr = atr14[i];

      // Test Target 1: +0.50% (Standard Dashboard T1) or 0.8x ATR
      // Stop Loss: 1.5x ATR or Supertrend distance
      const slDist = Math.max(1.5 * atr, entryPrice * 0.008);
      const t1Dist = Math.max(0.75 * atr, entryPrice * 0.005); // 0.50% Nifty move (approx 120-140 pts)
      const t2Dist = t1Dist * 2.0;

      const sl = sig === 'LONG' ? entryPrice - slDist : entryPrice + slDist;
      const t1 = sig === 'LONG' ? entryPrice + t1Dist : entryPrice - t1Dist;
      const t2 = sig === 'LONG' ? entryPrice + t2Dist : entryPrice - t2Dist;

      let hitT1 = false, hitT2 = false, hitSL = false;
      let exitIdx = i + 1;
      let pnl = 0;

      const maxHold = isDaily ? 10 : 24;

      for (let j = i + 1; j < Math.min(bars.length, i + 1 + maxHold); j++) {
        const b = bars[j];
        if (sig === 'LONG') {
          if (b.low <= sl) {
            hitSL = true;
            exitIdx = j;
            pnl = -slDist;
            break;
          }
          if (b.high >= t1 && !hitT1) {
            hitT1 = true;
          }
          if (b.high >= t2) {
            hitT2 = true;
            exitIdx = j;
            pnl = t2Dist;
            break;
          }
        } else {
          if (b.high >= sl) {
            hitSL = true;
            exitIdx = j;
            pnl = -slDist;
            break;
          }
          if (b.low <= t1 && !hitT1) {
            hitT1 = true;
          }
          if (b.low <= t2) {
            hitT2 = true;
            exitIdx = j;
            pnl = t2Dist;
            break;
          }
        }
      }

      if (!hitSL && !hitT2) {
        const lastClose = bars[Math.min(bars.length - 1, i + maxHold)].close;
        pnl = sig === 'LONG' ? lastClose - entryPrice : entryPrice - lastClose;
      }

      trades.push({
        date: cur.date,
        type: sig,
        entryPrice,
        hitT1,
        hitT2,
        hitSL,
        pnl
      });
    }

    const total = trades.length;
    if (total === 0) continue;
    const t1Wins = trades.filter(t => t.hitT1).length;
    const t2Wins = trades.filter(t => t.hitT2).length;
    const profitTrades = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.hitSL).length;
    const totalPnl = Math.round(trades.reduce((acc, t) => acc + t.pnl, 0));
    const winAmount = trades.filter(t => t.pnl > 0).reduce((acc, t) => acc + t.pnl, 0);
    const lossAmount = Math.abs(trades.filter(t => t.pnl < 0).reduce((acc, t) => acc + t.pnl, 0));
    const pf = lossAmount > 0 ? (winAmount / lossAmount).toFixed(2) : 'Inf';

    const t1Rate = ((t1Wins / total) * 100).toFixed(1);
    const winRate = ((profitTrades / total) * 100).toFixed(1);

    console.log(`\n>>> ${v.name}`);
    console.log(`  Total Trades:     ${total}`);
    console.log(`  Target 1 Hit Rate: ${t1Wins} / ${total} (${t1Rate}%)  <-- ACCURACY METRIC`);
    console.log(`  Target 2 Hit Rate: ${t2Wins} / ${total} (${((t2Wins/total)*100).toFixed(1)}%)`);
    console.log(`  Stop Loss Hits:   ${losses} (${((losses/total)*100).toFixed(1)}%)`);
    console.log(`  Profit Factor:    ${pf}`);
    console.log(`  Net Points:       ${totalPnl > 0 ? '+' : ''}${totalPnl} pts`);

    // Yearly Breakdown for the best variation
    const ymap = {};
    trades.forEach(t => {
      const yr = t.date.substring(0, 4);
      if (!ymap[yr]) ymap[yr] = { count: 0, t1: 0, pnl: 0 };
      ymap[yr].count++;
      if (t.hitT1) ymap[yr].t1++;
      ymap[yr].pnl += t.pnl;
    });
    console.log(`  Yearly Breakdown:`);
    for (const yr of Object.keys(ymap).sort()) {
      const item = ymap[yr];
      const r = ((item.t1 / item.count) * 100).toFixed(1);
      console.log(`    ${yr}: ${item.count} trades | T1 Hit Rate: ${r}% | Net: ${Math.round(item.pnl)} pts`);
    }
  }
}

runDeepOptimization(dailyBars, '7-YEAR NIFTY DAILY (Nov 2019 - Nov 2026)', true);
runDeepOptimization(hourlyBars, '3-YEAR NIFTY HOURLY (Nov 2023 - Nov 2026)', false);
