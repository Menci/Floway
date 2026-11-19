import { test } from 'vitest';

import { addDecimalStrings, divideDecimalString, multiplyDecimalStrings, parseDecimalString, parseNonNegativeDecimalString } from '../../src/common/decimal.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('decimal strings canonicalize without floating-point conversion', () => {
  assertEquals(parseDecimalString('001.2300'), '1.23');
  assertEquals(parseDecimalString('+001.2300'), '1.23');
  assertEquals(parseDecimalString('1e-7'), '0.0000001');
  assertEquals(parseDecimalString('-0'), '0');
  assertEquals(parseNonNegativeDecimalString('0.00000000000000000001'), '0.00000000000000000001');
  assertThrows(() => parseNonNegativeDecimalString(-1), TypeError);
  assertThrows(() => parseNonNegativeDecimalString('-0.1'), RangeError);
  assertEquals(parseDecimalString('1e-324'), `0.${'0'.repeat(323)}1`);
  assertThrows(() => parseDecimalString('1e401'), RangeError);
  assertThrows(() => parseDecimalString('1'.repeat(101)), RangeError);
  assertThrows(() => parseDecimalString('.1'), TypeError);
  assertThrows(() => parseDecimalString('1.'), TypeError);
  assertEquals(parseDecimalString(`1.${'0'.repeat(509)}`), '1');
  assertThrows(() => parseDecimalString(`1.${'0'.repeat(511)}`), TypeError);
  assertEquals(parseDecimalString('1e399'), `1${'0'.repeat(399)}`);
  assertThrows(() => parseDecimalString('1e400'), RangeError);
  assertEquals(parseDecimalString('1e-400'), `0.${'0'.repeat(399)}1`);
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
  assertThrows(() => addDecimalStrings('1'.repeat(1_001), '0'), RangeError);
  assertThrows(() => divideDecimalString('1', '0'), RangeError);
});

test('decimal division rounds half-up to 100 fractional digits', () => {
  const lastPlace = `0.${'0'.repeat(99)}1`;
  assertEquals(divideDecimalString('4', '1e101'), '0');
  assertEquals(divideDecimalString('1', '2e100'), lastPlace);
  assertEquals(divideDecimalString('-1', '2e100'), `-${lastPlace}`);
  assertEquals(divideDecimalString('6', '1e101'), lastPlace);
});
