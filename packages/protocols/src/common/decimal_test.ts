import { test } from 'vitest';

import { addDecimalStrings, canonicalDecimalString, divideDecimalString, multiplyDecimalStrings, parseNonNegativeDecimalString } from './decimal.ts';
import { assertEquals, assertThrows } from '../test-assert.ts';

test('decimal strings canonicalize without floating-point conversion', () => {
  assertEquals(canonicalDecimalString('001.2300'), '1.23');
  assertEquals(canonicalDecimalString('1e-7'), '0.0000001');
  assertEquals(canonicalDecimalString('-0'), '0');
  assertEquals(parseNonNegativeDecimalString('0.00000000000000000001'), '0.00000000000000000001');
  assertThrows(() => parseNonNegativeDecimalString(-1), TypeError, 'must be a decimal string');
  assertThrows(() => parseNonNegativeDecimalString('-0.1'), RangeError, 'must be non-negative');
});

test('decimal arithmetic preserves exact finite decimal results', () => {
  assertEquals(addDecimalStrings('0.1', '0.2'), '0.3');
  assertEquals(multiplyDecimalStrings('9007199254740993', '0.0000001'), '900719925.4740993');
  assertEquals(divideDecimalString('0.006', '60'), '0.0001');
});
