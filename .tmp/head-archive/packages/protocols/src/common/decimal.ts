import Big from 'big.js';

export type DecimalString = string;

interface DecimalLimits {
  inputLength: number;
  significantDigits: number;
  integerDigits: number;
  scale: number;
  exponent: number;
}

const PUBLIC_LIMITS: DecimalLimits = {
  inputLength: 512,
  significantDigits: 100,
  integerDigits: 400,
  scale: 400,
  exponent: 400,
};
const ARITHMETIC_LIMITS: DecimalLimits = {
  inputLength: 2_048,
  significantDigits: 1_000,
  integerDigits: 1_000,
  scale: 1_000,
  exponent: 400,
};
const DIVISION_SCALE = 100;
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:[.](\d+))?(?:[eE]([+-]?\d+))?$/;

const Decimal = Big();
Decimal.DP = DIVISION_SCALE;
Decimal.RM = Decimal.roundHalfUp;

const validateDecimalString = (value: string, label: string, limits: DecimalLimits): string => {
  if (value.length === 0 || value.length > limits.inputLength) {
    throw new TypeError(`${label} must be a decimal string of at most ${limits.inputLength} characters: ${JSON.stringify(value)}`);
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new TypeError(`${label} must be a decimal string: ${JSON.stringify(value)}`);
  const [, sign, rawInteger, rawFraction = '', rawExponent = '0'] = match;
  const exponent = Number(rawExponent);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > limits.exponent) {
    throw new RangeError(`${label} exponent must be between -${limits.exponent} and ${limits.exponent}: ${JSON.stringify(value)}`);
  }

  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  let digits = `${integer}${rawFraction}`.replace(/^0+/, '');
  if (digits === '') return value.startsWith('+') ? value.slice(1) : value;
  const significantDigits = digits.replace(/0+$/, '').length;
  if (significantDigits > limits.significantDigits) {
    throw new RangeError(`${label} must have at most ${limits.significantDigits} significant digits: ${JSON.stringify(value)}`);
  }

  let scale = rawFraction.length - exponent;
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  while (scale > 0 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    scale--;
  }
  const integerDigits = Math.max(1, digits.length - scale);
  if (integerDigits > limits.integerDigits || scale > limits.scale) {
    throw new RangeError(`${label} exceeds the supported ${limits.integerDigits}-digit integer or ${limits.scale}-digit scale: ${JSON.stringify(value)}`);
  }
  return sign === '+' ? value.slice(1) : value;
};

const parseDecimal = (value: string, label: string, limits: DecimalLimits) =>
  new Decimal(validateDecimalString(value, label, limits));

export const parseDecimalString = (value: string, label = 'decimal'): DecimalString =>
  parseDecimal(value, label, PUBLIC_LIMITS).toFixed();

export const parseNonNegativeDecimalString = (value: unknown, label = 'decimal'): DecimalString => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a decimal string: ${JSON.stringify(value)}`);
  const parsed = parseDecimal(value, label, PUBLIC_LIMITS);
  if (parsed.lt(0)) throw new RangeError(`${label} must be non-negative: ${JSON.stringify(value)}`);
  return parsed.toFixed();
};

export const addDecimalStrings = (left: DecimalString, right: DecimalString): DecimalString => {
  const a = parseDecimal(left, 'left decimal', ARITHMETIC_LIMITS);
  const b = parseDecimal(right, 'right decimal', ARITHMETIC_LIMITS);
  return a.plus(b).toFixed();
};

export const multiplyDecimalStrings = (left: DecimalString, right: DecimalString): DecimalString => {
  const a = parseDecimal(left, 'left decimal', ARITHMETIC_LIMITS);
  const b = parseDecimal(right, 'right decimal', ARITHMETIC_LIMITS);
  return a.times(b).toFixed();
};

// Division is the sole non-exact operation: repeating results are rounded
// half-up to 100 fractional digits. Prices, quantities, sums, and products
// remain exact finite decimals.
export const divideDecimalString = (value: DecimalString, divisor: DecimalString): DecimalString => {
  const dividend = parseDecimal(value, 'decimal dividend', ARITHMETIC_LIMITS);
  const denominator = parseDecimal(divisor, 'decimal divisor', ARITHMETIC_LIMITS);
  if (denominator.eq(0)) throw new RangeError('decimal divisor must not be zero');
  return dividend.div(denominator).toFixed();
};

export const decimalStringIsZero = (value: DecimalString): boolean =>
  parseDecimal(value, 'decimal', ARITHMETIC_LIMITS).eq(0);

export const decimalStringToNumber = (value: DecimalString): number =>
  Number(parseDecimal(value, 'decimal', ARITHMETIC_LIMITS).toFixed());
