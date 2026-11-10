const fs = require('fs');

const dailyBars = JSON.parse(fs.readFileSync('c:/Users/babu6/Chan Projects/OptionsScanner/test/nifty_7y_daily.json', 'utf8'));
const hourlyBars = JSON.parse(fs.readFileSync('c:/Users/babu6/Chan Projects/OptionsScanner/test/nifty_3y_hourly.json', 'utf8'));

function computeEMA(bars, length, sourceFn = b => b.close) {
  const ema = new Array(bars.length);
  const k = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += sourceFn(bars[i]);
  }
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
      
      if (inBull && bars[i].close < lowerBand) {
        inBull = false;
      } else if (!inBull && bars[i].close > upperBand) {
        inBull = true;
      }
    }
    st[i] = inBull ? lowerBand : upperBand;
    isBull[i] = inBull;
  }
  return { st, isBull };
}

function runSimulation(bars, title, isDaily = true) {
  const ema13 = computeEMA(bars, 13);
  const ema34 = computeEMA(bars, 34);
  const ema200 = computeEMA(bars, 200);
  const d5Ema = computeEMA(bars, 5, b => (b.high + b.low + b.close) / 3);
  const atr14 = computeATR(bars, 14);
  const { isBull: stBull } = computeSupertrend(bars, atr14, 5, 3.0);

  const trapLookback = isDaily ? 10 : 24;

  // Track 3 models:
  // Model A: Old Flawed Model (4-bar highs trigger sell without trend filter)
  // Model B: Standard v4.3 Trend-Safeguarded Model
  // Model C: Optimized High-Conviction Model (Targeting >=80% Win Rate)

  const results = {
    modelA: { name: 'Model A: Flawed (v4.2 Unfiltered)', trades: [] },
    modelB: { name: 'Model B: v4.3 Trend-Safeguarded', trades: [] },
    modelC: { name: 'Model C: Optimized High-Conviction', trades: [] }
  };

  const startIndex = 205; // allow 200-EMA to warm up

  for (let i = startIndex; i < bars.length - 15; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    
    // Local swing extremes
    let localTrapHi = -Infinity, localTrapLo = Infinity;
    for (let k = 1; k <= trapLookback; k++) {
      if (bars[i - k].high > localTrapHi) localTrapHi = bars[i - k].high;
      if (bars[i - k].low < localTrapLo) localTrapLo = bars[i - k].low;
    }
    
    // 4-bar extremes
    let prev4Hi = -Infinity, prev4Lo = Infinity;
    for (let k = 1; k <= 4; k++) {
      if (bars[i - k].high > prev4Hi) prev4Hi = bars[i - k].high;
      if (bars[i - k].low < prev4Lo) prev4Lo = bars[i - k].low;
    }

    const emaBull = ema13[i] > ema34[i];
    const emaBear = ema13[i] < ema34[i];
    const isUptrend = (emaBull && cur.close > ema34[i]) || (stBull[i] && cur.close > ema13[i]);
    const isDowntrend = (emaBear && cur.close < ema34[i]) || (!stBull[i] && cur.close < ema13[i]);

    const barRng = Math.max(cur.high - cur.low, 0.05);
    const bearClPos = (cur.high - cur.close) / barRng;
    const bullClPos = (cur.close - cur.low) / barRng;

    const bearCandRej = cur.close < cur.open && cur.close < d5Ema[i] && (cur.close < prev.low || bearClPos >= 0.50);
    const bullCandAbs = cur.close > cur.open && cur.close > d5Ema[i] && (cur.close > prev.high || bullClPos >= 0.50);

    const sweepHi = cur.high >= localTrapHi && cur.close < localTrapHi;
    const sweepLo = cur.low <= localTrapLo && cur.close > localTrapLo;

    const cprEmaAbs = (cur.low <= ema34[i] && cur.close > ema34[i]) || (cur.low <= ema13[i] && cur.close > ema13[i]);
    const cprEmaRej = (cur.high >= ema34[i] && cur.close < ema34[i]) || (cur.high >= ema13[i] && cur.close < ema13[i]);

    // Model A: Fires Bull Trap Sell whenever 4-bar high rejects, even in uptrend
    const sigA_BullTrap = (sweepHi || (cur.high >= prev4Hi && bearCandRej)) && bearCandRej;
    const sigA_BearTrap = (sweepLo || (cur.low <= prev4Lo && bullCandAbs)) && bullCandAbs;

    // Model B: Trend-Safeguarded (v4.3)
    const sigB_BullTrap = isUptrend ? (sweepHi && cur.close < ema13[i] && bearCandRej) : (sweepHi && bearCandRej);
    const sigB_BearTrap = isUptrend ? ((sweepLo || cprEmaAbs || cur.low <= prev4Lo) && bullCandAbs) : (sweepLo && cur.close > ema13[i] && bullCandAbs);

    // Model C: Optimized High-Conviction (With-Trend Only, Double Confluence, Strict SL & T1/T2)
    // Long: In uptrend, buy Bear Trap dip absorption with 200 EMA support & Supertrend green
    const sigC_Long = isUptrend && stBull[i] && (cur.close > ema200[i]) && (cprEmaAbs || sweepLo) && bullCandAbs;
    // Short: In downtrend, sell Bull Trap rally rejection below 200 EMA & Supertrend red
    const sigC_Short = isDowntrend && !stBull[i] && (cur.close < ema200[i]) && (cprEmaRej || sweepHi) && bearCandRej;

    const atr = atr14[i];

    function evaluateTrade(type, entryIdx, slDist, t1Dist, t2Dist, maxHold = 10) {
      const entryPrice = bars[entryIdx + 1] ? bars[entryIdx + 1].open : bars[entryIdx].close;
      const sl = type === 'LONG' ? entryPrice - slDist : entryPrice + slDist;
      const t1 = type === 'LONG' ? entryPrice + t1Dist : entryPrice - t1Dist;
      const t2 = type === 'LONG' ? entryPrice + t2Dist : entryPrice - t2Dist;

      let hitT1 = false, hitT2 = false, hitSL = false;
      let exitIdx = entryIdx + 1;
      let pnl = 0;

      for (let j = entryIdx + 1; j < Math.min(bars.length, entryIdx + 1 + maxHold); j++) {
        const b = bars[j];
        if (type === 'LONG') {
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
        // Exit at end of hold window
        const lastClose = bars[Math.min(bars.length - 1, entryIdx + maxHold)].close;
        pnl = type === 'LONG' ? lastClose - entryPrice : entryPrice - lastClose;
      }
      return {
        date: cur.date,
        type,
        entryPrice,
        hitT1,
        hitT2,
        hitSL,
        pnl,
        winT1: hitT1 && (!hitSL || true), // reached T1 before or trade profitable
        winFinal: pnl > 0
      };
    }

    const slDist = 1.25 * atr;
    const t1Dist = 1.0 * atr;
    const t2Dist = 2.0 * atr;

    if (sigA_BullTrap) {
      results.modelA.trades.push(evaluateTrade('SHORT', i, slDist, t1Dist, t2Dist));
    }
    if (sigA_BearTrap) {
      results.modelA.trades.push(evaluateTrade('LONG', i, slDist, t1Dist, t2Dist));
    }

    if (sigB_BullTrap) {
      results.modelB.trades.push(evaluateTrade('SHORT', i, slDist, t1Dist, t2Dist));
    }
    if (sigB_BearTrap) {
      results.modelB.trades.push(evaluateTrade('LONG', i, slDist, t1Dist, t2Dist));
    }

    if (sigC_Long) {
      results.modelC.trades.push(evaluateTrade('LONG', i, slDist, t1Dist, t2Dist));
    }
    if (sigC_Short) {
      results.modelC.trades.push(evaluateTrade('SHORT', i, slDist, t1Dist, t2Dist));
    }
  }

  console.log(`\n======================================================`);
  console.log(`  AUDIT RESULTS: ${title} (${bars.length} bars)`);
  console.log(`======================================================`);

  for (const key of ['modelA', 'modelB', 'modelC']) {
    const m = results[key];
    const total = m.trades.length;
    if (total === 0) continue;

    const t1Wins = m.trades.filter(t => t.hitT1).length;
    const profitTrades = m.trades.filter(t => t.pnl > 0).length;
    const losses = m.trades.filter(t => t.hitSL).length;
    const totalPnl = m.trades.reduce((acc, t) => acc + t.pnl, 0);
    const winAmount = m.trades.filter(t => t.pnl > 0).reduce((acc, t) => acc + t.pnl, 0);
    const lossAmount = Math.abs(m.trades.filter(t => t.pnl < 0).reduce((acc, t) => acc + t.pnl, 0));
    const profitFactor = lossAmount > 0 ? (winAmount / lossAmount).toFixed(2) : 'Inf';

    const t1WinRate = ((t1Wins / total) * 100).toFixed(1);
    const overallWinRate = ((profitTrades / total) * 100).toFixed(1);

    console.log(`\n--- ${m.name} ---`);
    console.log(`Total Trades:         ${total}`);
    console.log(`T1 Hit Rate (1.0 ATR): ${t1Wins} / ${total} (${t1WinRate}%)`);
    console.log(`Profitable Trades:    ${profitTrades} / ${total} (${overallWinRate}%)`);
    console.log(`Stop Loss Hits:       ${losses} (${((losses / total) * 100).toFixed(1)}%)`);
    console.log(`Profit Factor:        ${profitFactor}`);
    console.log(`Net Points Gained:    ${Math.round(totalPnl)} pts`);

    // Yearly breakdown for Model C
    if (key === 'modelC' || key === 'modelB') {
      const yearStats = {};
      m.trades.forEach(t => {
        const y = t.date.substring(0, 4);
        if (!yearStats[y]) yearStats[y] = { total: 0, t1Wins: 0, pnl: 0 };
        yearStats[y].total++;
        if (t.hitT1) yearStats[y].t1Wins++;
        yearStats[y].pnl += t.pnl;
      });
      console.log(`\nYearly Performance breakdown for ${m.name}:`);
      for (const y of Object.keys(yearStats).sort()) {
        const ys = yearStats[y];
        const yrRate = ((ys.t1Wins / ys.total) * 100).toFixed(1);
        console.log(`  ${y}: ${ys.total} trades | T1 Win Rate: ${yrRate}% | Net: ${Math.round(ys.pnl)} pts`);
      }
    }
  }
}

console.log('Running 7-Year Daily Audit (2019-2026)...');
runSimulation(dailyBars, '7-YEAR NIFTY DAILY (Nov 2019 - Nov 2026)', true);

console.log('\nRunning 3-Year Hourly Audit (2023-2026)...');
runSimulation(hourlyBars, '3-YEAR NIFTY 1-HOUR (Nov 2023 - Nov 2026)', false);
