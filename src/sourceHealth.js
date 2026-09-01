const SOURCE_ERROR_RE = /Unexpected token|Edge:\s*Too|^Error$|^#(?:VALUE!|N\/A|REF!|DIV\/0!|NAME\?|NUM!|NULL!)$/i;

const MARKET_DATA_COLUMNS = [
  "Price",
  "Daily Pivot",
  "Weekly Pivot",
  "Monthly Pivot",
  "Confluence",
  "Inside Day",
  "Inside Value",
  "Buy Above",
  "Sell Below",
];

export function hasSourceError(row) {
  return MARKET_DATA_COLUMNS.some(column => SOURCE_ERROR_RE.test(String(row[column] ?? "").trim()));
}

export function isTradableSourceRow(row) {
  const buyAbove = Number(row["Buy Above"]);
  const sellBelow = Number(row["Sell Below"]);
  return Boolean(row["NSE Symbol"]) && !hasSourceError(row) &&
    Number.isFinite(buyAbove) && buyAbove > 0 &&
    Number.isFinite(sellBelow) && sellBelow > 0;
}
