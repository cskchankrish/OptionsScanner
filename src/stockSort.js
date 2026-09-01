const TIER_WEIGHT = { A:4, B:3, C:2, D:1 };

const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const triggerCount = stock => Number(Boolean(stock.signals?.insideDay)) + Number(Boolean(stock.signals?.insideVal));
const tierWeight = stock => TIER_WEIGHT[stock.conviction?.tier] || 0;

function smartBand(stock) {
  const rank = stock.conviction?.rank;
  const strong = tierWeight(stock) >= TIER_WEIGHT.B ||
    numberOr(stock.conviction?.trend, 0) >= 20 ||
    (Number.isFinite(rank) && rank <= 300);
  const triggered = triggerCount(stock) > 0;
  if (triggered && strong) return 3;
  if (triggered) return 2;
  return strong ? 1 : 0;
}

const bySetup = (a, b) => numberOr(b.score, 0) - numberOr(a.score, 0);
const byTrend = (a, b) => numberOr(b.conviction?.trend, -1) - numberOr(a.conviction?.trend, -1);
const byRank = (a, b) => numberOr(a.conviction?.rank, Infinity) - numberOr(b.conviction?.rank, Infinity);
const byTier = (a, b) => tierWeight(b) - tierWeight(a);
const bySymbol = (a, b) => String(a.sym || "").localeCompare(String(b.sym || ""));

export function compareStocks(a, b, mode = "smart") {
  if (mode === "setup") return bySetup(a, b) || byRank(a, b) || bySymbol(a, b);
  if (mode === "rank") return byRank(a, b) || byTier(a, b) || byTrend(a, b) || bySetup(a, b) || bySymbol(a, b);
  if (mode === "trend") return byTrend(a, b) || byRank(a, b) || bySetup(a, b) || bySymbol(a, b);

  return smartBand(b) - smartBand(a) ||
    triggerCount(b) - triggerCount(a) ||
    byTier(a, b) ||
    byTrend(a, b) ||
    byRank(a, b) ||
    bySetup(a, b) ||
    bySymbol(a, b);
}
