import { NO_READING } from './no-reading';
import {
  addDecimalStrings,
  decimalStringIsZero,
  decimalStringToNumber,
  type DecimalString,
} from '@floway-dev/protocols/common';

const splitDecimal = (value: DecimalString): [integer: string, fraction: string] => {
  const [integer, fraction = ''] = value.split('.');
  if (integer === undefined || integer.startsWith('-')) throw new TypeError(`Expected a canonical non-negative decimal: ${JSON.stringify(value)}`);
  return [integer, fraction];
};

const compareDecimalStrings = (left: DecimalString, right: DecimalString): number => {
  const [leftInteger, leftFraction] = splitDecimal(left);
  const [rightInteger, rightFraction] = splitDecimal(right);
  if (leftInteger.length !== rightInteger.length) return leftInteger.length < rightInteger.length ? -1 : 1;
  if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(scale, '0');
  const normalizedRight = rightFraction.padEnd(scale, '0');
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
};

const toFixed = (value: DecimalString, scale: number): string => {
  const [integer, fraction] = splitDecimal(value);
  const retained = fraction.slice(0, scale).padEnd(scale, '0');
  let coefficient = BigInt(`${integer}${retained}`);
  if ((fraction[scale] ?? '0') >= '5') coefficient++;
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

export const sumDecimalStrings = (...values: readonly DecimalString[]): DecimalString =>
  values.reduce(addDecimalStrings, '0');

export const decimalStringToPlottableNumber = (value: DecimalString): number => {
  const numeric = decimalStringToNumber(value);
  if (!Number.isFinite(numeric) || (numeric === 0 && !decimalStringIsZero(value))) {
    throw new RangeError(`Decimal is outside the finite nonzero plottable number range: ${value}`);
  }
  return numeric;
};

export const formatDecimalQuantity = (value: DecimalString): string => {
  const [integer, fraction] = splitDecimal(value);
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === '' ? grouped : `${grouped}.${fraction}`;
};

// Callers hold different value types — the summary tile exact decimal strings, the
// usage chart's axis plotted floats — and must still agree on the digit count.
export const usdFractionDigits = (atLeast: (boundary: DecimalString) => boolean): 2 | 3 | 4 =>
  atLeast('1') ? 2 : atLeast('0.01') ? 3 : 4;

export const formatUsd = (value: DecimalString | null): string => {
  if (value === null) return NO_READING;
  if (decimalStringIsZero(value)) return '$0';
  return `$${toFixed(value, usdFractionDigits(boundary => compareDecimalStrings(value, boundary) >= 0))}`;
};
