import { createPublicKey, verify, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { loadX509FromPem, setCryptoImplementation } from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';
import { describe, expect, it } from 'vitest';

import { ecdsaSignatureFixtures } from './fixtures/ecdsa-signatures.generated.ts';

const encodeDerSignature = (r: Uint8Array, s: Uint8Array): Uint8Array =>
  new Uint8Array([0x30, 4 + r.length + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);

describe('userspace TLS — ECDSA signatures', () => {
  // Public CA certificates reproduce the Cloudflare chain failure in #583.
  // The issuing CA's P-384 signature has a 47-byte r and a 48-byte s.
  // https://repo-certs.ssl.com/repo/certs/Cloudflare-TLS-I-E4.pem
  // https://www.ssl.com/repo/certs/SSL.com-TLS-T-ECC-R2.der
  it('verifies Cloudflare TLS Issuing ECC CA 4 with SSL.com TLS Transit ECC CA R2', async () => {
    const [certificatePem, issuerPem] = await Promise.all([
      readFile(new URL('./fixtures/cloudflare-ecc-ca-4.generated.pem', import.meta.url), 'utf8'),
      readFile(new URL('./fixtures/ssl-com-tls-transit-ecc-r2.generated.pem', import.meta.url), 'utf8'),
    ]);
    const nativeCertificate = new X509Certificate(certificatePem);
    const nativeIssuer = new X509Certificate(issuerPem);
    expect(nativeCertificate.verify(nativeIssuer.publicKey)).toBe(true);

    setCryptoImplementation(webcryptoCrypto);
    const certificate = loadX509FromPem(certificatePem);
    const issuer = loadX509FromPem(issuerPem);
    expect(issuer.isIssuer(certificate)).toBe(true);
    await expect(issuer.verifyIssued(certificate)).resolves.toBe(true);
  });

  it.each(ecdsaSignatureFixtures)('verifies $algorithm with $shape integers', async fixture => {
    const signature = Buffer.from(fixture.signature, 'base64');
    const data = Buffer.from(fixture.data, 'base64');
    const publicKey = createPublicKey(fixture.publicKey);
    const hash = fixture.algorithm.endsWith('SHA256') ? 'sha256' : 'sha384';
    expect(verify(hash, data, publicKey, signature)).toBe(true);

    const r = signature.subarray(4, 4 + signature[3]!);
    const s = signature.subarray(6 + signature[3]!);
    if (fixture.shape === 'sign-padded') {
      expect(r).toHaveLength(fixture.width + 1);
      expect(s).toHaveLength(fixture.width + 1);
      expect(r[0]).toBe(0);
      expect(s[0]).toBe(0);
    } else {
      const integer = fixture.shape === 'short-r' ? r : s;
      expect(integer.length - (integer[0] === 0 ? 1 : 0)).toBeLessThan(fixture.width);
    }

    const algorithm = fixture.algorithm;
    const importedKey = await webcryptoCrypto.importKey(
      algorithm,
      new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
      'public',
    );
    await expect(webcryptoCrypto.verify(algorithm, {
      signature, data, publicKey: importedKey,
    })).resolves.toBe(true);

    const corruptedData = new Uint8Array(data);
    corruptedData[0] ^= 1;
    await expect(webcryptoCrypto.verify(algorithm, {
      signature, data: corruptedData, publicKey: importedKey,
    })).resolves.toBe(false);
    await expect(webcryptoCrypto.verify(algorithm, {
      signature: encodeDerSignature(new Uint8Array([0, ...r]), s), data, publicKey: importedKey,
    })).rejects.toThrow('Invalid ECDSA signature integer');
    await expect(webcryptoCrypto.verify(algorithm, {
      signature: encodeDerSignature(r, new Uint8Array([0, ...s])), data, publicKey: importedKey,
    })).rejects.toThrow('Invalid ECDSA signature integer');
    await expect(webcryptoCrypto.verify(algorithm, {
      signature: encodeDerSignature(new Uint8Array([0]), s), data, publicKey: importedKey,
    })).resolves.toBe(false);
    await expect(webcryptoCrypto.verify(algorithm, {
      signature: encodeDerSignature(r, new Uint8Array([0])), data, publicKey: importedKey,
    })).resolves.toBe(false);
  });

  it.each(ecdsaSignatureFixtures.filter(fixture => fixture.shape === 'sign-padded'))(
    'rejects negative and oversized DER integers for $algorithm', async fixture => {
      const signature = Buffer.from(fixture.signature, 'base64');
      const r = signature.subarray(4, 4 + signature[3]!);
      const s = signature.subarray(6 + signature[3]!);
      const publicKey = await webcryptoCrypto.importKey(
        fixture.algorithm,
        new Uint8Array(createPublicKey(fixture.publicKey).export({ type: 'spki', format: 'der' })),
        'public',
      );
      const data = Buffer.from(fixture.data, 'base64');

      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(r.subarray(1), s), data, publicKey,
      })).rejects.toThrow('Invalid ECDSA signature integer');
      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(r, s.subarray(1)), data, publicKey,
      })).rejects.toThrow('Invalid ECDSA signature integer');
      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(new Uint8Array([1, ...r.subarray(1)]), s), data, publicKey,
      })).rejects.toThrow('ECDSA signature integer exceeds curve size');
      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(r, new Uint8Array([1, ...s.subarray(1)])), data, publicKey,
      })).rejects.toThrow('ECDSA signature integer exceeds curve size');
    },
  );
});
