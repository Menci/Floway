import { beforeAll, describe, expect, test, vi } from 'vitest';

import { hashPassword, isSupportedPasswordHash, verifyPassword } from '../../src/shared/passwords.ts';

const PERSISTED_PASSWORD = 'persisted-password';
const PERSISTED_HASH = 'pbkdf2-sha256$1000$AAECAwQFBgcICQoLDA0ODw==$rep5GM+JZ4GSYa/Qxf4tY9KFd/PnYjJdCeYGWosl/ug=';

describe('passwords', () => {
  let generatedHash: string;

  beforeAll(async () => {
    generatedHash = await hashPassword('hunter2');
  });

  test('hashPassword produces the supported persisted encoding', () => {
    const parts = generatedHash.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2-sha256');
    expect(parts[1]).toBe('100000');
    expect(parts[2]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(parts[3]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(isSupportedPasswordHash(generatedHash)).toBe(true);
  });

  test('verifyPassword accepts matching generated and fixed persisted hashes', async () => {
    expect(await verifyPassword('hunter2', generatedHash)).toBe(true);
    expect(await verifyPassword(PERSISTED_PASSWORD, PERSISTED_HASH)).toBe(true);
  });

  test('verifyPassword rejects a different plaintext', async () => {
    expect(await verifyPassword('hunter3', generatedHash)).toBe(false);
  });

  test('structurally invalid or unsupported hashes return false without deriving', async () => {
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');
    const malformed = [
      'not-an-encoded-string',
      PERSISTED_HASH.replace('$1000$', '$0$'),
      PERSISTED_HASH.replace('$1000$', '$01000$'),
      PERSISTED_HASH.replace('$1000$', '$1000.5$'),
      PERSISTED_HASH.replace('$1000$', '$100001$'),
      PERSISTED_HASH.replace('AAECAwQFBgcICQoLDA0ODw==', 'AAECAwQFBgcICQoLDA0O'),
      PERSISTED_HASH.replace('rep5GM+JZ4GSYa/Qxf4tY9KFd/PnYjJdCeYGWosl/ug=', 'rep5GM+JZ4GSYa/Qxf4tY9KFd/PnYjJdCeYGWosl'),
      PERSISTED_HASH.replace('pbkdf2-sha256', 'argon2'),
    ];
    try {
      for (const encoded of malformed) {
        expect(isSupportedPasswordHash(encoded)).toBe(false);
        expect(await verifyPassword('x', encoded)).toBe(false);
      }
      expect(deriveSpy).not.toHaveBeenCalled();
    } finally {
      deriveSpy.mockRestore();
    }
  });

  test('two hashes of the same plaintext use different salts', async () => {
    expect(await hashPassword('hunter2')).not.toBe(generatedHash);
  });
});
