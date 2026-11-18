import { test } from 'vitest';

import { parseServerSecret } from '../../src/shared/server-secret.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('parseServerSecret accepts only the canonical serialized form', () => {
  const secret = 'ab'.repeat(32);
  assertEquals(parseServerSecret(secret), secret);
  for (const invalid of [undefined, 'ab'.repeat(31), 'AB'.repeat(32), `${'ab'.repeat(31)}zz`]) {
    assertThrows(
      () => parseServerSecret(invalid),
      Error,
      'must be exactly 64 lowercase hexadecimal characters',
    );
  }
});
