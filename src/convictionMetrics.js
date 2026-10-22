const COLUMN_NAMES = {
  rank: "Conviction Rank",
  tier: "Conviction Tier",
  rs: "Conviction RS",
  volume: "Conviction Volume",
  trend: "Conviction Trend",
  base: "Conviction Base",
  flow: "Spurt Flow",
  spurtRvol: "Spurt RVOL",
  spurtValCr: "Spurt Value Cr",
};

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function readConvictionMetrics(row) {
  const tier = String(row[COLUMN_NAMES.tier] ?? "").trim().toUpperCase();
  const flowRaw = String(row[COLUMN_NAMES.flow] ?? "").trim().toUpperCase();
  const flow = flowRaw.includes("ACC")
    ? "ACCUMULATION"
    : flowRaw.includes("DIST")
    ? "DISTRIBUTION"
    : null;

  return {
    rank: optionalNumber(row[COLUMN_NAMES.rank]),
    tier: /^[ABCD]$/.test(tier) ? tier : null,
    rs: optionalNumber(row[COLUMN_NAMES.rs]),
    volume: optionalNumber(row[COLUMN_NAMES.volume]),
    trend: optionalNumber(row[COLUMN_NAMES.trend]),
    base: optionalNumber(row[COLUMN_NAMES.base]),
    flow,
    spurtRvol: optionalNumber(row[COLUMN_NAMES.spurtRvol]),
    spurtValCr: optionalNumber(row[COLUMN_NAMES.spurtValCr]),
  };
}

export function hasConvictionMetrics(metrics) {
  return /^[ABCD]$/.test(metrics?.tier || "") ||
    Boolean(metrics?.flow) ||
    Object.entries(metrics || {}).some(([key, value]) => !["tier", "flow"].includes(key) && Number.isFinite(value));
}
