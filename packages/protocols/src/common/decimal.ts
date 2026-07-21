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

interface FixedDecimal {
  coefficient: bigint;
  scale: number;
}

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

const formatFixedDecimal = ({ coefficient, scale }: FixedDecimal): DecimalString => {
  if (coefficient === 0n) return '0';
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    const split = digits.length - scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/[.]?0+$/, '');
  }
  return negative ? `-${digits}` : digits;
};

const parseFixedDecimal = (value: string, label: string, limits: DecimalLimits): FixedDecimal => {
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
  if (digits === '') return { coefficient: 0n, scale: 0 };
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
  const coefficient = BigInt(digits) * (sign === '-' ? -1n : 1n);
  return { coefficient, scale };
};

export const canonicalDecimalString = (value: string, label = 'decimal'): DecimalString =>
  formatFixedDecimal(parseFixedDecimal(value, label, PUBLIC_LIMITS));

export const parseNonNegativeDecimalString = (value: unknown, label = 'decimal'): DecimalString => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a decimal string: ${JSON.stringify(value)}`);
  const parsed = parseFixedDecimal(value, label, PUBLIC_LIMITS);
  if (parsed.coefficient < 0n) throw new RangeError(`${label} must be non-negative: ${JSON.stringify(value)}`);
  return formatFixedDecimal(parsed);
};

export const addDecimalStrings = (left: DecimalString, right: DecimalString): DecimalString => {
  const a = parseFixedDecimal(left, 'left decimal', ARITHMETIC_LIMITS);
  const b = parseFixedDecimal(right, 'right decimal', ARITHMETIC_LIMITS);
  const scale = Math.max(a.scale, b.scale);
  return formatFixedDecimal({
    coefficient: a.coefficient * pow10(scale - a.scale) + b.coefficient * pow10(scale - b.scale),
    scale,
  });
};

export const multiplyDecimalStrings = (left: DecimalString, right: DecimalString): DecimalString => {
  const a = parseFixedDecimal(left, 'left decimal', ARITHMETIC_LIMITS);
  const b = parseFixedDecimal(right, 'right decimal', ARITHMETIC_LIMITS);
  return formatFixedDecimal({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
};

// Division is the sole non-exact operation: repeating results are rounded
// half-up to 100 fractional digits. Prices, quantities, sums, and products
// remain exact finite decimals.
export const divideDecimalString = (value: DecimalString, divisor: DecimalString): DecimalString => {
  const numeratorValue = parseFixedDecimal(value, 'decimal dividend', ARITHMETIC_LIMITS);
  const divisorValue = parseFixedDecimal(divisor, 'decimal divisor', ARITHMETIC_LIMITS);
  if (divisorValue.coefficient === 0n) throw new RangeError('decimal divisor must not be zero');

  const numerator = numeratorValue.coefficient * pow10(divisorValue.scale + DIVISION_SCALE);
  const denominator = divisorValue.coefficient * pow10(numeratorValue.scale);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  if (absRemainder * 2n >= absDenominator) quotient += numerator * denominator < 0n ? -1n : 1n;
  return formatFixedDecimal({ coefficient: quotient, scale: DIVISION_SCALE });
};

export const decimalStringIsZero = (value: DecimalString): boolean =>
  parseFixedDecimal(value, 'decimal', ARITHMETIC_LIMITS).coefficient === 0n;

export const decimalStringToNumber = (value: DecimalString): number =>
  Number(formatFixedDecimal(parseFixedDecimal(value, 'decimal', ARITHMETIC_LIMITS)));
