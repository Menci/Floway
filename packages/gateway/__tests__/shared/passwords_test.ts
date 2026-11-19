import { describe, expect, test } from 'vitest';

import { hashPassword, verifyPassword } from '../../src/shared/passwords.ts';

describe('passwords', () => {

  test('verifies a fixed password hash in the persisted format', async () => {
    const encoded = 'pbkdf2-sha256$1000$AAECAwQFBgcICQoLDA0ODw==$rep5GM+JZ4GSYa/Qxf4tY9KFd/PnYjJdCeYGWosl/ug=';
    expect(await verifyPassword('persisted-password', encoded)).toBe(true);
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
});
