const decimals = (value: number, maximumFractionDigits: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);

// Binary units, one fraction digit below ten of a unit and none above; two at the
// top of the ladder so the whole range fits in three significant figures.
export const formatBytes = (value: number, locale: string): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${decimals(value / 1024, value < 10 * 1024 ? 1 : 0, locale)} KB`;
  if (value < 1024 ** 3) return `${decimals(value / 1024 ** 2, value < 10 * 1024 ** 2 ? 1 : 0, locale)} MB`;
  return `${decimals(value / 1024 ** 3, 2, locale)} GB`;
};

// `Intl` rather than a hand-rolled thousands ladder: zh-Hans groups by 万, not K.
export const formatCompactCount = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

// Clamped at zero: a negative tally is an arithmetic artifact, not a quantity.
export const formatCount = (value: number, locale: string): string =>
  Math.max(0, Math.round(value)).toLocaleString(locale);

// Three significant figures across the range, so a column of rates stays the same
// width and stays comparable digit by digit.
export const formatTokenRate = (tokensPerSecond: number | null): string => {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return '-';
  if (tokensPerSecond >= 100) return `${Math.round(tokensPerSecond)} tok/s`;
  if (tokensPerSecond >= 10) return `${tokensPerSecond.toFixed(1)} tok/s`;
  return `${tokensPerSecond.toFixed(2)} tok/s`;
};

// Telemetry records time per output token; the reader wants its reciprocal.
export const formatTokenRateFromTpot = (us: number | null): string =>
  us === null || us <= 0 ? '-' : formatTokenRate(1_000_000 / us);
