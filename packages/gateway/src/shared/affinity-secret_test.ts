import { test } from 'vitest';

import { generateAffinitySecret, parseAffinitySecret } from './affinity-secret.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('generateAffinitySecret creates independent 32-byte lowercase hexadecimal secrets', () => {
  const first = generateAffinitySecret();
  const second = generateAffinitySecret();
  assertEquals(/^[0-9a-f]{64}$/.test(first), true);
  assertEquals(/^[0-9a-f]{64}$/.test(second), true);
  assertEquals(first === second, false);
});

test('parseAffinitySecret accepts only the canonical serialized form', () => {
  const secret = 'ab'.repeat(32);
  assertEquals(parseAffinitySecret(secret), secret);
  for (const invalid of [undefined, 'ab'.repeat(31), 'AB'.repeat(32), `${'ab'.repeat(31)}zz`]) {
    assertThrows(
      () => parseAffinitySecret(invalid),
      Error,
      'must be exactly 64 lowercase hexadecimal characters',
    );
  }
});
