import { describe, expect, it } from 'vitest';

import { decimalStringToPlottableNumber, formatDecimalQuantity, formatUsd, sumDecimalStrings } from '../../src/lib/decimal-display';
import { NO_READING } from '../../src/lib/no-reading';

describe('decimal display', () => {
  it('aggregates and formats without binary floating-point rounding', () => {
    expect(sumDecimalStrings('9007199254740993', '0.1', '0.2')).toBe('9007199254740993.3');
    expect(formatDecimalQuantity('9007199254740993.3')).toBe('9,007,199,254,740,993.3');
    expect(formatUsd('1.005')).toBe('$1.01');
    expect(formatUsd('0.0105')).toBe('$0.011');
    expect(formatUsd('0.00005')).toBe('$0.0001');
    expect(formatUsd(null)).toBe(NO_READING);
  });

  it('rejects decimal values a numeric chart axis cannot represent', () => {
    expect(decimalStringToPlottableNumber('9007199254740993')).toBe(9_007_199_254_740_992);
    expect(() => decimalStringToPlottableNumber(`0.${'0'.repeat(323)}1`)).toThrow(RangeError);
    expect(() => decimalStringToPlottableNumber(`1${'0'.repeat(400)}`)).toThrow(RangeError);
  });
});
