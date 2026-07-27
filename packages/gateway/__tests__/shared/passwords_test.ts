import { describe, expect, test } from 'vitest';

import { hashPassword, verifyPassword } from '../../src/shared/passwords.ts';

describe('passwords', () => {
  test('hashPassword produces a well-formed encoded string', async () => {
    const encoded = await hashPassword('hunter2');
    const parts = encoded.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2-sha256');
    expect(parts[1]).toBe('100000');
    expect(parts[2]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(parts[3]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test('verifyPassword accepts the matching plaintext', async () => {
    const encoded = await hashPassword('hunter2');
    expect(await verifyPassword('hunter2', encoded)).toBe(true);
  });

  test('verifyPassword rejects a different plaintext', async () => {
    const encoded = await hashPassword('hunter2');
    expect(await verifyPassword('hunter3', encoded)).toBe(false);
  });

  test('verifyPassword rejects malformed encoded strings', async () => {
    expect(await verifyPassword('x', 'not-an-encoded-string')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$0$YQ==$YQ==')).toBe(false);
    expect(await verifyPassword('x', 'argon2$10000$YQ==$YQ==')).toBe(false);
  });

  test('two hashes of the same plaintext differ (random salt)', async () => {
    const a = await hashPassword('hunter2');
    const b = await hashPassword('hunter2');
    expect(a).not.toBe(b);
  });
});
