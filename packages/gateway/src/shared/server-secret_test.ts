import { test } from 'vitest';

import { generateServerSecret, parseServerSecret, serverSecretBytes } from './server-secret.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('generateServerSecret creates independent 32-byte lowercase hexadecimal secrets', () => {
  const first = generateServerSecret();
  const second = generateServerSecret();
  assertEquals(/^[0-9a-f]{64}$/.test(first), true);
  assertEquals(/^[0-9a-f]{64}$/.test(second), true);
  assertEquals(first === second, false);
});

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

test('serverSecretBytes decodes the canonical hexadecimal representation', () => {
  assertEquals(serverSecretBytes(`00${'ff'.repeat(31)}`), new Uint8Array([0, ...Array<number>(31).fill(255)]));
});
