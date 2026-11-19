import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { hexDecode } from '../../src/encoding.ts';
import {
  buildRealityAad,
  buildRealitySessionId,
  dialReality,
  verifyRealityLeaf,
} from '../../src/protocols/reality.ts';
import type { RealityProxyConfig } from '../../src/proxy-config.ts';
import type { DialTarget } from '../../src/types.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';

describe('buildRealitySessionId', () => {
  it('packs version, timestamp, and short id into 32 bytes', () => {
    const sid = buildRealitySessionId([25, 4, 30], 0x12345678, hexDecode('00112233445566aa'));
    expect(Array.from(sid.subarray(0, 4))).toEqual([25, 4, 30, 0x00]);
    expect(Array.from(sid.subarray(4, 8))).toEqual([0x12, 0x34, 0x56, 0x78]);
    expect(Array.from(sid.subarray(8, 16))).toEqual([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0xaa]);
    // Bytes 16..31 left zero — Xray fills these with the AEAD ciphertext+tag.
    expect(Array.from(sid.subarray(16))).toEqual(new Array(16).fill(0));
  });
});

describe('buildRealityAad', () => {
  it('zeros the 32-byte session_id slot at offset 39', () => {
    const ch = new Uint8Array(200);
    for (let i = 0; i < ch.byteLength; i++) ch[i] = (i * 37) & 0xff;

    const aad = buildRealityAad(ch);
    // Bytes outside [39, 71) are untouched.
    for (let i = 0; i < 39; i++) expect(aad[i]).toBe(ch[i]);
    for (let i = 71; i < ch.byteLength; i++) expect(aad[i]).toBe(ch[i]);
    // Bytes [39, 71) are zero.
    for (let i = 39; i < 71; i++) expect(aad[i]).toBe(0);
  });
});

const target: DialTarget = { host: 'api.openai.com', port: 443 };

const realityConfig = (overrides: Partial<RealityProxyConfig> = {}): RealityProxyConfig => ({
  kind: 'reality',
  uuid: '11111111-2222-3333-4444-555555555555',
  // 32 well-formed base64url bytes — overridden in the bad-pbk case below.
  publicKey: 'A'.repeat(43),
  serverName: 'www.cloudflare.com',
  host: 'h',
  port: 443,
  name: 'r',
  ...overrides,
});

describe('dialReality — pre-connect config validation', () => {
  // Pre-connect failures must surface as ProxyDialError so the caller's
  // fallback chain still triggers.
  it('rejects an unparseable pbk base64 string as a typed dial error', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ publicKey: '!!!not-base64!!!' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
    });
    expect(fake.connectCount()).toBe(0);
  });
});

describe('dialReality — runtime X25519 derive failure', () => {
  // A 32-byte all-zero pbk is decodable but its high-order representation
  // fails Web Crypto's X25519 importKey/deriveBits with an OperationError.
  // The operator pastes the wrong public key from their proxy generator far
  // more often than they paste a non-base64 string, so the dial layer must
  // surface that failure as a config-stage ProxyDialError rather than let
  // the raw DOMException escape as a framework 500.
  it('wraps an off-curve / mistyped pbk that decodes but fails ECDH as a config-stage dial error', async () => {
    // 32 bytes of zero, encoded as 43 base64url chars (one byte of padding
    // would round to '=', which we strip — reality.ts accepts both forms).
    const allZeroPbk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ publicKey: allZeroPbk }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
    });
    // The TCP socket WAS opened (the derive failure happens inside the
    // outer-TLS state machine, after connect succeeds). We don't assert
    // connectCount here — only that the failure is shaped right.
  });
});

describe('verifyRealityLeaf', () => {
  // RFC 8410 §4 fixed Ed25519 SPKI prefix; with a 32-byte raw key glued on
  // it forms the 44-byte SubjectPublicKeyInfo every real REALITY leaf carries.
  const ED25519_SPKI_PREFIX = hexDecode('302a300506032b6570032100');
  const buildSpki = (rawPub: Uint8Array): Uint8Array => {
    const spki = new Uint8Array(ED25519_SPKI_PREFIX.byteLength + 32);
    spki.set(ED25519_SPKI_PREFIX);
    spki.set(rawPub, ED25519_SPKI_PREFIX.byteLength);
    return spki;
  };
  // We don't need a parser-valid X.509 to exercise verifyRealityLeaf — only
  // the last 64 bytes of the DER buffer matter to the check, mirroring
  // Xray's server-side overwrite at cert[len-64:].
  const buildLeafDer = (tail: Uint8Array, prefixLen = 200): Uint8Array => {
    if (tail.byteLength !== 64) throw new Error('tail must be 64 bytes');
    const der = new Uint8Array(prefixLen + 64);
    for (let i = 0; i < prefixLen; i++) der[i] = (i * 53) & 0xff;
    der.set(tail, prefixLen);
    return der;
  };

  it('accepts a leaf whose DER tail is HMAC-SHA512(authKey, leafEd25519Pub)', () => {
    const authKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) authKey[i] = i + 1;
    const rawPub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) rawPub[i] = (i * 7) & 0xff;
    const tag = hmac(sha512, authKey, rawPub);
    const der = buildLeafDer(tag);
    expect(() => verifyRealityLeaf(authKey, der, buildSpki(rawPub))).not.toThrow();
  });

  it('rejects a leaf whose DER tail does not match the recomputed HMAC', () => {
    const authKey = new Uint8Array(32);
    const rawPub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) rawPub[i] = i;
    // A tail computed under a different authKey — the bytes are well-formed
    // 64 bytes but do not equal HMAC(authKey, pub).
    const wrongTag = hmac(sha512, new Uint8Array(32).fill(0xff), rawPub);
    const der = buildLeafDer(wrongTag);
    expect(() => verifyRealityLeaf(authKey, der, buildSpki(rawPub)))
      .toThrow();
  });
});
