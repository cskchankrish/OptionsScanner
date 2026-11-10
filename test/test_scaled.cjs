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

function testScaledExecution(bars, isDaily) {
  const ema13 = computeEMA(bars, 13);
  const ema34 = computeEMA(bars, 34);
  const ema89 = computeEMA(bars, 89);
  const ema200 = computeEMA(bars, 200);
  const d5Ema = computeEMA(bars, 5, b => (b.high + b.low + b.close) / 3);
  const atr14 = computeATR(bars, 14);
  const { isBull: stBull } = computeSupertrend(bars, atr14, 5, 3.0);

  // Strategy Setup:
  // With-trend Dip Absorption Bear Traps + Trend Re-entries
  // Long: Uptrend (ema13 > ema34 and close > ema89), dip to ema13/34 and close back above 5-EMA
  // Short: Downtrend (ema13 < ema34 and close < ema89), rally to ema13/34 and close back below 5-EMA

  const trades = [];
  let lastBar = -999;
  const cooldown = isDaily ? 2 : 4;

  for (let i = 205; i < bars.length - 10; i++) {
    if (i - lastBar < cooldown) continue;
    const cur = bars[i];
    const prev = bars[i - 1];

    const isBull = ema13[i] > ema34[i] && cur.close > ema89[i] && stBull[i];
    const isBear = ema13[i] < ema34[i] && cur.close < ema89[i] && !stBull[i];

    const barRng = Math.max(cur.high - cur.low, 0.05);
    const bullClPos = (cur.close - cur.low) / barRng;
    const bearClPos = (cur.high - cur.close) / barRng;

    const longSig = isBull && cur.low <= ema13[i] && cur.close > d5Ema[i] && bullClPos >= 0.45;
    const shortSig = isBear && cur.high >= ema13[i] && cur.close < d5Ema[i] && bearClPos >= 0.45;

    if (!longSig && !shortSig) continue;

    lastBar = i;
    const type = longSig ? 'LONG' : 'SHORT';
    const entryPrice = bars[i + 1] ? bars[i + 1].open : cur.close;
    const atr = atr14[i];

    // Execution Setup:
    // T1: 0.50x ATR (approx 45-60 pts on hourly, 90-120 pts on daily) -> Take 60% profit, SL to BE
    // T2: 1.50x ATR (approx 140-180 pts on hourly, 250-350 pts on daily) -> Take remaining 40%
    // Initial SL: 1.25x ATR (below swing base)
    const slDist = 1.25 * atr;
    const t1Dist = 0.50 * atr;
    const t2Dist = 1.50 * atr;

    const initialSL = type === 'LONG' ? entryPrice - slDist : entryPrice + slDist;
    const t1 = type === 'LONG' ? entryPrice + t1Dist : entryPrice - t1Dist;
    const t2 = type === 'LONG' ? entryPrice + t2Dist : entryPrice - t2Dist;

    let hitT1 = false;
    let hitT2 = false;
    let hitSL = false;
    let currentSL = initialSL;
    let netPnl = 0;

    const maxHold = isDaily ? 8 : 16;

    for (let j = i + 1; j < Math.min(bars.length, i + 1 + maxHold); j++) {
      const b = bars[j];
      if (type === 'LONG') {
        // Check SL first
        if (b.low <= currentSL) {
          hitSL = true;
          if (hitT1) {
            // Already took 60% profit at T1! Remaining 40% stopped at BE (0 pnl)
            netPnl = 0.60 * t1Dist + 0.40 * 0;
          } else {
            // Full position stopped out
            netPnl = -slDist;
          }
          break;
        }

        // Check T1
        if (b.high >= t1 && !hitT1) {
          hitT1 = true;
          currentSL = entryPrice; // TRAIL SL TO BREAKEVEN!
        }

        // Check T2
        if (b.high >= t2) {
          hitT2 = true;
          netPnl = 0.60 * t1Dist + 0.40 * t2Dist;
          break;
        }
      } else {
        // Short side
        if (b.high >= currentSL) {
          hitSL = true;
          if (hitT1) {
            netPnl = 0.60 * t1Dist + 0.40 * 0;
          } else {
            netPnl = -slDist;
          }
          break;
        }

        if (b.low <= t1 && !hitT1) {
          hitT1 = true;
          currentSL = entryPrice; // TRAIL SL TO BREAKEVEN!
        }

        if (b.low <= t2) {
          hitT2 = true;
          netPnl = 0.60 * t1Dist + 0.40 * t2Dist;
          break;
        }
      }
    }

    if (!hitSL && !hitT2) {
      const lastClose = bars[Math.min(bars.length - 1, i + maxHold)].close;
      const endDiff = type === 'LONG' ? lastClose - entryPrice : entryPrice - lastClose;
      if (hitT1) {
        netPnl = 0.60 * t1Dist + 0.40 * Math.max(0, endDiff);
      } else {
        netPnl = endDiff;
      }
    }

    trades.push({
      date: cur.date,
      type,
      entryPrice,
      hitT1,
      hitT2,
      hitSL,
      netPnl,
      isWin: netPnl > 0
    });
  }

  const total = trades.length;
  const wins = trades.filter(t => t.isWin).length;
  const winRate = ((wins / total) * 100).toFixed(1);
  const totalPoints = Math.round(trades.reduce((acc, t) => acc + t.netPnl, 0));
  const winAmt = trades.filter(t => t.netPnl > 0).reduce((acc, t) => acc + t.netPnl, 0);
  const lossAmt = Math.abs(trades.filter(t => t.netPnl < 0).reduce((acc, t) => acc + t.netPnl, 0));
  const pf = (winAmt / (lossAmt || 1)).toFixed(2);

  console.log(`\n======================================================`);
  console.log(`  INSTITUTIONAL SCALED EXECUTION AUDIT (${isDaily ? '7-YEAR DAILY' : '3-YEAR HOURLY'})`);
  console.log(`======================================================`);
  console.log(`Total Trades:       ${total}`);
  console.log(`Winning Trades:     ${wins} / ${total} (${winRate}%)  <-- WIN RATE`);
  console.log(`Profit Factor:      ${pf}`);
  console.log(`Net Points Gained:  +${totalPoints} pts`);

  // Yearly breakdown
  const yrObj = {};
  trades.forEach(t => {
    const y = t.date.substring(0, 4);
    if (!yrObj[y]) yrObj[y] = { count: 0, wins: 0, pnl: 0 };
    yrObj[y].count++;
    if (t.isWin) yrObj[y].wins++;
    yrObj[y].pnl += t.netPnl;
  });
  console.log(`\nYear-by-Year Win Rate Breakdown:`);
  for (const y of Object.keys(yrObj).sort()) {
    const o = yrObj[y];
    const r = ((o.wins / o.count) * 100).toFixed(1);
    console.log(`  ${y}: ${o.count} trades | Win Rate: ${r}% | Net: +${Math.round(o.pnl)} pts`);
  }
}

testScaledExecution(dailyBars, true);
testScaledExecution(hourlyBars, false);
