import { decodeTime } from 'ulid';
import { test, vi } from 'vitest';

import { assertEquals } from '@floway-dev/test-utils';

const TIMESTAMP = 2_000_000_000_000;

const loadUlid = async () => {
  vi.resetModules();
  return (await import('../../src/shared/ulid.ts')).ulid;
};

test('ulid produces canonical, increasing ids for an explicit epoch timestamp', async () => {
  const ulid = await loadUlid();
  const a = ulid(0);
  const b = ulid(0);

  assertEquals(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(a), true);
  assertEquals(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(b), true);
  assertEquals(a < b, true);
  assertEquals(decodeTime(a), 0);
  assertEquals(decodeTime(b), 0);
});

test('ulid produces strictly increasing ids within the same millisecond', async () => {
  const ulid = await loadUlid();
  const a = ulid(TIMESTAMP);
  const b = ulid(TIMESTAMP);
  const c = ulid(TIMESTAMP);

  assertEquals(a < b, true);
  assertEquals(b < c, true);
  assertEquals(decodeTime(a), TIMESTAMP);
  assertEquals(decodeTime(b), TIMESTAMP);
  assertEquals(decodeTime(c), TIMESTAMP);
});

test('ulid encodes and orders consecutive milliseconds', async () => {
  const ulid = await loadUlid();
  const a = ulid(TIMESTAMP + 1);
  const b = ulid(TIMESTAMP + 2);

  assertEquals(a < b, true);
  assertEquals(decodeTime(a), TIMESTAMP + 1);
  assertEquals(decodeTime(b), TIMESTAMP + 2);
});

test('ulid produces strictly increasing ids when the clock rewinds', async () => {
  const ulid = await loadUlid();
  const a = ulid(TIMESTAMP + 3);
  const b = ulid(TIMESTAMP - 1_000);
  const c = ulid(TIMESTAMP - 2_000);

  assertEquals(a < b, true);
  assertEquals(b < c, true);
  assertEquals(decodeTime(b), TIMESTAMP + 3);
  assertEquals(decodeTime(c), TIMESTAMP + 3);
});
