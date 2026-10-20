import { test } from 'vitest';

import { parseJSONWithRawNumbers, parsePartialJSONWithRawNumbers } from '../../src/common/json.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('parseJSONWithRawNumbers preserves every number token that would serialize differently', () => {
  const source = '{"safe":9007199254740991,"decimal":1.25,"rounded":0.10000000000000001,"negativeZero":-0,"exponent":1e2,"trailing":1.2300,"large":900719925474099312345,"overflow":1e999}';
  const value = parseJSONWithRawNumbers(source) as Record<string, unknown>;
  const json = JSON as typeof JSON & { isRawJSON: (value: unknown) => boolean };

  assertEquals(value.safe, 9007199254740991);
  assertEquals(value.decimal, 1.25);
  assert(json.isRawJSON(value.rounded));
  assert(json.isRawJSON(value.negativeZero));
  assert(json.isRawJSON(value.exponent));
  assert(json.isRawJSON(value.trailing));
  assert(json.isRawJSON(value.large));
  assert(json.isRawJSON(value.overflow));
  assertEquals(JSON.stringify(value), source);
});

test('parsePartialJSONWithRawNumbers preserves complete noncanonical number tokens', () => {
  const source = '{"rounded":0.10000000000000001,"negativeZero":-0,"unfinished":';
  const value = parsePartialJSONWithRawNumbers(source) as Record<string, unknown>;

  assertEquals(JSON.stringify(value), '{"rounded":0.10000000000000001,"negativeZero":-0}');
});

test('parsePartialJSONWithRawNumbers keeps complete source values from an incomplete object', () => {
  const source = String.raw`{"__proto__":{"polluted":true},"text":"\ud800","large":900719925474099312345,"unfinished":`;
  const value = parsePartialJSONWithRawNumbers(source) as Record<string, unknown>;
  const json = JSON as typeof JSON & { isRawJSON: (value: unknown) => boolean };

  assert(Object.hasOwn(value, '__proto__'));
  assertEquals(Object.getPrototypeOf(value), Object.prototype);
  assertEquals((value['__proto__'] as Record<string, unknown>).polluted, true);
  assertEquals((value.text as string).charCodeAt(0), 0xd800);
  assert(json.isRawJSON(value.large));
  assertEquals(value.unfinished, undefined);
  assertEquals(JSON.stringify(value), String.raw`{"__proto__":{"polluted":true},"text":"\ud800","large":900719925474099312345}`);
});

test('parsePartialJSONWithRawNumbers drops an unterminated numeric token', () => {
  const value = parsePartialJSONWithRawNumbers('{"count":123') as Record<string, unknown>;

  assertEquals(value, {});
});
