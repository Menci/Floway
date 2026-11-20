import { decodeTime } from 'ulid';
import { test, vi } from 'vitest';

import { assertEquals } from '@floway-dev/test-utils';

const TIMESTAMP = 2_000_000_000_000;

const loadUlid = async () => {
  vi.resetModules();
  return (await import('../../src/shared/ulid.ts')).ulid;
};

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
