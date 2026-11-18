import { describe, expect, it } from 'vitest';

import {
  installSecureContextCrypto,
  portableSubtle,
} from '../../src/lib/secure-context-crypto';

// Captured before any install call, so that the digests below are compared
// against the engine's own implementation rather than against the subject.
const nativeSubtle = crypto.subtle;
const message = new TextEncoder().encode('abc');

const nativeDigest = async (algorithm: string) =>
  new Uint8Array(await nativeSubtle.digest(algorithm, message));

describe('portable digest', () => {
  it('matches the platform digest for every algorithm Web Crypto defines', async () => {
    for (const algorithm of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
      const digest = new Uint8Array(await portableSubtle.digest(algorithm, message));
      expect(digest, algorithm).toStrictEqual(await nativeDigest(algorithm));
    }
  });

  it('rejects an unrecognized algorithm', async () => {
    await expect(portableSubtle.digest('MD5', message)).rejects.toThrow(
      expect.objectContaining({ name: 'NotSupportedError' }),
    );
  });
});

describe('installSecureContextCrypto', () => {
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
