import { gcm } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { hexDecode } from '../../src/bytes.ts';
import {
  buildRealityAad,
  buildRealitySessionId,
  dialReality,
  extractEd25519RawPubKey,
  parseShortId,
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

  it('rejects a short-id that is not exactly 8 bytes', () => {
    expect(() => buildRealitySessionId([25, 4, 30], 0, new Uint8Array(7))).toThrow(/shortId/);
    expect(() => buildRealitySessionId([25, 4, 30], 0, new Uint8Array(9))).toThrow(/shortId/);
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

  it('returns a fresh buffer rather than mutating the input', () => {
    const ch = new Uint8Array(200);
    ch[40] = 0xab;
    const aad = buildRealityAad(ch);
    expect(ch[40]).toBe(0xab);
    expect(aad[40]).toBe(0);
  });
});

describe('buildRealityAad — AEAD round trip', () => {
  it('a 16-byte plaintext sealed with AES-256-GCM under our AAD shape decrypts losslessly', () => {
    // Smoke test that the AAD-shape contract round-trips through AES-256-GCM,
    // independent of any TLS plumbing. If the AAD-zeroing layout ever changes,
    // this fails immediately.
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const ch = new Uint8Array(120);
    for (let i = 0; i < ch.byteLength; i++) ch[i] = i;
    const aad = buildRealityAad(ch);
    const sid = buildRealitySessionId([25, 4, 30], 0x66778899, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const sealed = gcm(key, nonce, aad).encrypt(sid.subarray(0, 16));
    expect(sealed.byteLength).toBe(32);
    const opened = gcm(key, nonce, aad).decrypt(sealed);
    expect(Array.from(opened)).toEqual(Array.from(sid.subarray(0, 16)));
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
      message: expect.stringContaining('invalid base64'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a pbk whose decoded length is not 32 bytes', async () => {
    const fake = makeFakeSocketDial();
    // Three base64 chars decode to only 2 bytes — not 32.
    await expect(
      dialReality(realityConfig({ publicKey: 'AAA' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('pubkey must be 32 bytes'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects an odd-length sid hex string as a typed dial error', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ shortId: 'abc' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('invalid hex'),
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
      message: expect.stringContaining('pbk failed X25519 derive'),
    });
    // The TCP socket WAS opened (the derive failure happens inside the
    // outer-TLS state machine, after connect succeeds). We don't assert
    // connectCount here — only that the failure is shaped right.
  });
});

describe('dialReality — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('1..65535'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a non-ASCII target host at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('ASCII'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a 256-byte target host at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig(), { host: 'a'.repeat(256), port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('too long'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});

describe('buildRealitySessionId — timestamp and shortId encoding', () => {
  it('packs ts=0 as four zero bytes', () => {
    const sid = buildRealitySessionId([25, 4, 30], 0, new Uint8Array(8));
    expect(Array.from(sid.subarray(4, 8))).toEqual([0, 0, 0, 0]);
  });

  it('packs ts=0xffffffff as four 0xff bytes', () => {
    const sid = buildRealitySessionId([25, 4, 30], 0xffffffff, new Uint8Array(8));
    expect(Array.from(sid.subarray(4, 8))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('preserves arbitrary shortId byte values verbatim at offset 8', () => {
    const sid = buildRealitySessionId([1, 2, 3], 42, hexDecode('deadbeefcafe1234'));
    expect(Array.from(sid.subarray(8, 16))).toEqual([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0x12, 0x34]);
  });
});

describe('buildRealityAad — clientHello boundary cases', () => {
  it('handles a clientHello exactly 71 bytes long (last byte is at session_id end)', () => {
    const ch = new Uint8Array(71);
    for (let i = 0; i < ch.byteLength; i++) ch[i] = i;
    const aad = buildRealityAad(ch);
    for (let i = 39; i < 71; i++) expect(aad[i]).toBe(0);
    for (let i = 0; i < 39; i++) expect(aad[i]).toBe(i);
  });

  it('preserves bytes immediately adjacent to the zeroed slot (offsets 38 and 71)', () => {
    const ch = new Uint8Array(100);
    ch[38] = 0xaa;
    ch[71] = 0xbb;
    const aad = buildRealityAad(ch);
    expect(aad[38]).toBe(0xaa);
    expect(aad[71]).toBe(0xbb);
    expect(aad[39]).toBe(0);
    expect(aad[70]).toBe(0);
  });

  it('produces a buffer the same length as the input', () => {
    const ch = new Uint8Array(300);
    const aad = buildRealityAad(ch);
    expect(aad.byteLength).toBe(300);
  });
});

describe('dialReality — pre-connect base64 decoder corner cases', () => {
  // base64url with padding stripped — common in URI form. The decoder
  // re-adds '=' padding internally. We verify the decoder reaches the
  // connect call without throwing; the actual TLS handshake doesn't happen
  // because we abort right after.
  const verifyReachesConnect = async (publicKey: string): Promise<void> => {
    const fake = makeFakeSocketDial();
    const ctrl = new AbortController();
    const p = dialReality(realityConfig({ publicKey }), target, { socketDial: fake.socketDial, signal: ctrl.signal });
    p.catch(() => { /* aborted dial — we only care that we reached connect */ });
    await fake.awaitConnect();
    ctrl.abort();
    expect(fake.connectCount()).toBe(1);
    await Promise.race([p, new Promise(r => setTimeout(r, 50))]).catch(() => {});
  };

  it('accepts a 43-char base64url string (no padding)', async () => {
    // 'A'.repeat(43) decodes to 32 zero bytes (32-byte pubkey).
    await verifyReachesConnect('A'.repeat(43));
  });

  it('accepts a 44-char base64 string with explicit padding', async () => {
    await verifyReachesConnect(`${'A'.repeat(43)}=`);
  });

  it('accepts a base64url string with the URL-safe alphabet (- and _)', async () => {
    // 32 bytes of 0xfe yields a 43-char base64url with '-' and '_' characters.
    await verifyReachesConnect('_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v4');
  });

  it('rejects a 33-byte pubkey (one byte too long)', async () => {
    const fake = makeFakeSocketDial();
    // 33 bytes = 44 base64 chars without padding.
    const tooLong = 'A'.repeat(44);
    await expect(
      dialReality(realityConfig({ publicKey: tooLong }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('pubkey must be 32 bytes'),
    });
  });
});

describe('dialReality — shortId hex decoder corner cases', () => {
  const verifyReachesConnect = async (shortId: string | undefined): Promise<void> => {
    const fake = makeFakeSocketDial();
    const ctrl = new AbortController();
    const p = dialReality(realityConfig({ shortId }), target, { socketDial: fake.socketDial, signal: ctrl.signal });
    p.catch(() => { /* aborted dial — we only care that we reached connect */ });
    await fake.awaitConnect();
    ctrl.abort();
    expect(fake.connectCount()).toBe(1);
    await Promise.race([p, new Promise(r => setTimeout(r, 50))]).catch(() => {});
  };

  it('accepts uppercase hex characters', async () => {
    await verifyReachesConnect('AABBCCDDEEFF1122');
  });

  it('accepts the all-zeros 16-char shortId', async () => {
    await verifyReachesConnect('0000000000000000');
  });

  it('accepts an empty sid (the documented default — zero-pads to all-zeros)', async () => {
    await verifyReachesConnect('');
  });

  it('accepts an undefined sid (treated as empty)', async () => {
    await verifyReachesConnect(undefined);
  });

  it('accepts shorter hex slices — Xray-core copy(SessionId[8:], shortId) leaves the tail zero', async () => {
    await verifyReachesConnect('aabb');
    await verifyReachesConnect('aabbccddeeff');
  });

  it('rejects a 17-char hex shortId — exceeds the 8-byte (16 hex char) slot', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialReality(realityConfig({ shortId: '0011223344556677889' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('shortId hex must be 0..16 chars'),
    });
  });
});

describe('parseShortId', () => {
  it('zero-pads an empty sid to 8 bytes', () => {
    const padded = parseShortId('');
    expect(padded.byteLength).toBe(8);
    expect(Array.from(padded)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('zero-pads an undefined sid to 8 bytes', () => {
    const padded = parseShortId(undefined);
    expect(Array.from(padded)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('zero-pads a 2-char hex sid into the leading byte, leaving the tail zero', () => {
    expect(Array.from(parseShortId('aa'))).toEqual([0xaa, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('packs a full 16-char hex sid into all 8 bytes verbatim', () => {
    expect(Array.from(parseShortId('0011223344556677'))).toEqual([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  });
});

describe('extractEd25519RawPubKey', () => {
  // RFC 8410 §4: an Ed25519 SubjectPublicKeyInfo is a fixed 44-byte DER blob,
  // 12 bytes of SEQUENCE+OID+BITSTRING prefix followed by the 32-byte raw key.
  const ED25519_SPKI_PREFIX = hexDecode('302a300506032b6570032100');

  it('returns the 32-byte raw key for a valid Ed25519 SPKI', () => {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = i;
    const spki = new Uint8Array(ED25519_SPKI_PREFIX.byteLength + 32);
    spki.set(ED25519_SPKI_PREFIX, 0);
    spki.set(raw, ED25519_SPKI_PREFIX.byteLength);
    expect(Array.from(extractEd25519RawPubKey(spki))).toEqual(Array.from(raw));
  });

  it('rejects an SPKI whose total length is not 44 bytes', () => {
    expect(() => extractEd25519RawPubKey(new Uint8Array(43))).toThrow(/44 bytes/);
    expect(() => extractEd25519RawPubKey(new Uint8Array(45))).toThrow(/44 bytes/);
  });

  it('rejects an SPKI with a non-Ed25519 prefix', () => {
    // RSA SPKI starts with a different SEQUENCE shape; first byte still 0x30,
    // but the algorithm OID block differs. Flip one byte in the OID region to
    // simulate a wrong-algorithm leaf cert.
    const spki = new Uint8Array(44);
    spki.set(ED25519_SPKI_PREFIX, 0);
    spki[6] = 0xff;
    expect(() => extractEd25519RawPubKey(spki)).toThrow(/prefix mismatch/);
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
      .toThrow(/HMAC-SHA512.*did not match/);
  });

  it('rejects a leaf whose pubkey is not Ed25519', () => {
    const authKey = new Uint8Array(32);
    const rawPub = new Uint8Array(32);
    const tag = hmac(sha512, authKey, rawPub);
    const der = buildLeafDer(tag);
    // Build an SPKI of the right length but wrong OID byte.
    const badSpki = buildSpki(rawPub);
    badSpki[6] = 0xff;
    expect(() => verifyRealityLeaf(authKey, der, badSpki))
      .toThrow(/not Ed25519/);
  });

  it('rejects a DER shorter than 64 bytes (no room for the HMAC tag)', () => {
    const authKey = new Uint8Array(32);
    const rawPub = new Uint8Array(32);
    expect(() => verifyRealityLeaf(authKey, new Uint8Array(50), buildSpki(rawPub)))
      .toThrow(/cannot hold a 64-byte HMAC tag/);
  });

  it('matches a tag flipped one bit at the boundary as a length-positional check', () => {
    // Smoke test that the tail check is positional (last 64 bytes) and a
    // single-bit flip is rejected — guards against accidental off-by-one
    // (e.g. comparing against bytes [-65, -1) instead of [-64, end)).
    const authKey = new Uint8Array(32).fill(0x42);
    const rawPub = new Uint8Array(32).fill(0x24);
    const tag = hmac(sha512, authKey, rawPub);
    const flipped = new Uint8Array(tag);
    flipped[0] ^= 0x01;
    expect(() => verifyRealityLeaf(authKey, buildLeafDer(flipped), buildSpki(rawPub)))
      .toThrow(/HMAC-SHA512.*did not match/);
  });
});
