const COLUMN_NAMES = {
  rank: "Conviction Rank",
  rs: "Conviction RS",
  volume: "Conviction Volume",
  trend: "Conviction Trend",
  base: "Conviction Base",
};

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function readConvictionMetrics(row) {
  return Object.fromEntries(
    Object.entries(COLUMN_NAMES).map(([key, column]) => [key, optionalNumber(row[column])]),
  );
}

export function hasConvictionMetrics(metrics) {
  return Object.values(metrics || {}).some(Number.isFinite);
}
