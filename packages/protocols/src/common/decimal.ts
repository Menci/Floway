import Decimal from 'decimal.js';

export type DecimalString = string;

const ExactDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1_000_000,
  toExpPos: 1_000_000,
});

const parseDecimal = (value: DecimalString): Decimal => {
  try {
    return new ExactDecimal(value);
  } catch (cause) {
    throw new TypeError(`invalid decimal string: ${JSON.stringify(value)}`, { cause });
  }
};

export const canonicalDecimalString = (value: string, label = 'decimal'): DecimalString => {
  let decimal: Decimal;
  try {
    decimal = new ExactDecimal(value);
  } catch (cause) {
    throw new TypeError(`${label} must be a decimal string: ${JSON.stringify(value)}`, { cause });
  }
  if (!decimal.isFinite()) throw new TypeError(`${label} must be finite: ${JSON.stringify(value)}`);
  return decimal.isZero() ? '0' : decimal.toFixed();
};

export const parseNonNegativeDecimalString = (value: unknown, label = 'decimal'): DecimalString => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a decimal string: ${JSON.stringify(value)}`);
  const canonical = canonicalDecimalString(value, label);
  if (parseDecimal(canonical).isNegative()) throw new RangeError(`${label} must be non-negative: ${JSON.stringify(value)}`);
  return canonical;
};

export const addDecimalStrings = (left: DecimalString, right: DecimalString): DecimalString =>
  parseDecimal(left).add(parseDecimal(right)).toFixed();

export const multiplyDecimalStrings = (left: DecimalString, right: DecimalString): DecimalString =>
  parseDecimal(left).mul(parseDecimal(right)).toFixed();

export const divideDecimalString = (value: DecimalString, divisor: DecimalString): DecimalString =>
  parseDecimal(value).div(parseDecimal(divisor)).toFixed();

export const decimalStringIsZero = (value: DecimalString): boolean => parseDecimal(value).isZero();

export const decimalStringToNumber = (value: DecimalString): number => parseDecimal(value).toNumber();
