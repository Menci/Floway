import { test } from 'vitest';

import { addDecimalStrings, divideDecimalString, multiplyDecimalStrings, parseDecimalString, parseNonNegativeDecimalString } from './decimal.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('decimal strings canonicalize without floating-point conversion', () => {
  assertEquals(parseDecimalString('001.2300'), '1.23');
  assertEquals(parseDecimalString('1e-7'), '0.0000001');
  assertEquals(parseDecimalString('-0'), '0');
  assertEquals(parseNonNegativeDecimalString('0.00000000000000000001'), '0.00000000000000000001');
  assertThrows(() => parseNonNegativeDecimalString(-1), TypeError, 'must be a decimal string');
  assertThrows(() => parseNonNegativeDecimalString('-0.1'), RangeError, 'must be non-negative');
  assertEquals(parseDecimalString('1e-324'), `0.${'0'.repeat(323)}1`);
  assertThrows(() => parseDecimalString('1e401'), RangeError, 'exponent must be between');
  assertThrows(() => parseDecimalString('1'.repeat(101)), RangeError, 'significant digits');
});

test('decimal arithmetic preserves exact finite decimal results', () => {
  assertEquals(addDecimalStrings('0.1', '0.2'), '0.3');
  assertEquals(multiplyDecimalStrings('9007199254740993', '0.0000001'), '900719925.4740993');
  assertEquals(divideDecimalString('0.006', '60'), '0.0001');
  assertEquals(
    addDecimalStrings('9'.repeat(80), '0.00000000000000000001'),
    `${'9'.repeat(80)}.00000000000000000001`,
  );
  const subnormalProduct = multiplyDecimalStrings('1e-324', '1e-324');
  assertEquals(subnormalProduct, `0.${'0'.repeat(647)}1`);
  assertEquals(addDecimalStrings(subnormalProduct, subnormalProduct), `0.${'0'.repeat(647)}2`);
});
