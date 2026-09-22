import { describe, expect, it } from 'vitest';

import {
  installSecureContextCrypto,
  portableRandomUUID,
  portableSubtle,
} from '../../src/lib/secure-context-crypto';

// Captured before any install call, so that the digests below are compared
// against the engine's own implementation rather than against the subject.
const nativeSubtle = crypto.subtle;
const message = new TextEncoder().encode('abc');

const nativeDigest = async (algorithm: string) =>
  new Uint8Array(await nativeSubtle.digest(algorithm, message));

// Installing writes own properties onto the platform `Crypto`, whose real
// members live on the prototype; deleting them is what hands the engine's own
// back to the rest of the run.
const withInstalled = async <T>(body: () => Promise<T>): Promise<T> => {
  installSecureContextCrypto();
  try {
    return await body();
  } finally {
    delete (crypto as Partial<Crypto>).randomUUID;
    Reflect.deleteProperty(crypto, 'subtle');
  }
};

describe('portable randomUUID', () => {
  it('mints version 4 UUIDs', () => {
    expect(portableRandomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('draws a fresh value each time', () => {
    expect(new Set(Array.from({ length: 128 }, portableRandomUUID)).size).toBe(128);
  });
});

describe('portable digest', () => {
  it('matches the platform digest for every algorithm Web Crypto defines', async () => {
    for (const algorithm of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
      const digest = new Uint8Array(await portableSubtle.digest(algorithm, message));
      expect(digest, algorithm).toStrictEqual(await nativeDigest(algorithm));
    }
  });

  it('accepts the algorithm as an object and matches its name case-insensitively', async () => {
    const digest = new Uint8Array(await portableSubtle.digest({ name: 'sha-256' }, message));
    expect(digest).toStrictEqual(await nativeDigest('SHA-256'));
  });

  it('reads a view without reaching past its bounds', async () => {
    const backing = new Uint8Array([0xff, ...message, 0xff]);
    const digest = new Uint8Array(
      await portableSubtle.digest('SHA-256', backing.subarray(1, 1 + message.length)),
    );
    expect(digest).toStrictEqual(await nativeDigest('SHA-256'));
  });

  it('reads a bare ArrayBuffer', async () => {
    const buffer = new ArrayBuffer(message.length);
    new Uint8Array(buffer).set(message);
    const digest = new Uint8Array(await portableSubtle.digest('SHA-256', buffer));
    expect(digest).toStrictEqual(await nativeDigest('SHA-256'));
  });

  it('rejects an unrecognized algorithm', async () => {
    await expect(portableSubtle.digest('MD5', message)).rejects.toThrow(
      expect.objectContaining({ name: 'NotSupportedError' }),
    );
  });
});

describe('portable key operations', () => {
  it('report themselves unsupplied rather than answering wrongly', async () => {
    await expect(
      portableSubtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']),
    ).rejects.toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
  });
});

describe('installSecureContextCrypto', () => {
  it('takes over both members even where the engine supplies its own', async () => {
    expect(nativeSubtle).not.toBe(portableSubtle);
    await withInstalled(async () => {
      expect(crypto.randomUUID).toBe(portableRandomUUID);
      expect(crypto.subtle).toBe(portableSubtle);
    });
  });

  it('answers on a Crypto that carries neither', async () => {
    const platform = crypto;
    const gated = { getRandomValues: platform.getRandomValues.bind(platform) };
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: gated });
    try {
      installSecureContextCrypto();
      expect(crypto.randomUUID()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
      expect(digest).toStrictEqual(await nativeDigest('SHA-256'));
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: platform });
    }
  });
});
