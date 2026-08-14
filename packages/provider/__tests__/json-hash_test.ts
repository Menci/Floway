import { expect, test } from 'vitest';

import { sha256Json, sha256JsonHex } from '../src/json-hash.ts';

test('hashes the exact prefixed JSON byte sequence incrementally', async () => {
  const value = {
    images: Array.from({ length: 4 }, (_, index) => ({ index, data: 'A'.repeat(1024 * 1024) })),
    exponent: 1e21,
    unicode: '中文😀\ud800',
  };
  const prefix = 'instructions\u0001';
  const expected = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${prefix}${JSON.stringify(value)}`),
  ));

  expect(sha256Json(value, prefix)).toEqual(expected);
  expect(sha256JsonHex(value, prefix)).toBe([...expected].map(byte => byte.toString(16).padStart(2, '0')).join(''));
});
