import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { describe, expect, it } from 'vitest';

import { buildSsAddress, dialShadowsocks, evpBytesToKey } from '../../src/protocols/shadowsocks.ts';
import type { ShadowsocksProxyConfig } from '../../src/proxy-config.ts';
import type { DialTarget } from '../../src/types.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };

const config = (overrides: Partial<ShadowsocksProxyConfig> = {}): ShadowsocksProxyConfig => ({
  kind: 'ss',
  method: 'aes-128-gcm',
  password: 'shadow',
  host: 'proxy.example',
  port: 8388,
  name: 'ss',
  ...overrides,
});

describe('evpBytesToKey', () => {
  // Reference: shadowsocks-rust crypto/v1/openssl_bytes_to_key.rs and
  // OpenSSL's EVP_BytesToKey when key+iv length total fits in one MD5 block.
  // Verified externally with `openssl enc -aes-128-cbc -k secret -P -nosalt`.
  it('matches the canonical "secret" → AES-128 vector', () => {
    const key = evpBytesToKey('secret', 16);
    expect(toHex(key)).toBe('5ebe2294ecd0e0f08eab7690d2a6ee69');
  });

  it('extends to 32 bytes by chaining MD5 blocks', () => {
    const key = evpBytesToKey('shadow', 32);
    expect(key.byteLength).toBe(32);
    // First block: MD5("shadow"); second block: MD5(MD5("shadow") || "shadow").
    expect(toHex(key.subarray(0, 16))).toBe('3bf1114a986ba87ed28fc1b5884fc2f8');
  });
});

describe('buildSsAddress', () => {
  it('encodes ATYP=0x03 | dom_len | dom | port[BE]', () => {
    const out = buildSsAddress('api.openai.com', 443);
    expect(out[0]).toBe(0x03);
    expect(out[1]).toBe(14);
    expect(new TextDecoder().decode(out.subarray(2, 16))).toBe('api.openai.com');
    expect(out[16]).toBe(0x01);
    expect(out[17]).toBe(0xbb);
  });
});

describe('dialShadowsocks — AEAD frame round trip', () => {
  it('emits a salt of method-key length followed by an addr-bearing AEAD frame', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();

    const KEY_LEN = 16;
    const TAG_LEN = 16;
    const masterKey = evpBytesToKey('shadow', KEY_LEN);
    const sendSalt = await srv.read(KEY_LEN);
    const sendKey = hkdf(sha1, masterKey, sendSalt, new TextEncoder().encode('ss-subkey'), KEY_LEN);

    // First frame after the salt: encrypted 2-byte length + tag, then the
    // ciphertext+tag of the address (1 + 1 + 14 + 2 = 18 bytes plain).
    const lenSealed = await srv.read(2 + TAG_LEN);
    const lenPlain = gcm(sendKey, nonce(0)).decrypt(lenSealed);
    const len = (lenPlain[0]! << 8) | lenPlain[1]!;
    expect(len).toBe(18);
    const ptSealed = await srv.read(len + TAG_LEN);
    const addr = gcm(sendKey, nonce(1)).decrypt(ptSealed);
    expect(Array.from(addr)).toEqual(Array.from(buildSsAddress(target.host, target.port)));

    // Server-side reply: choose our own salt, derive the recv subkey, send
    // a single AEAD frame with payload "DATA".
    const recvSalt = new Uint8Array(KEY_LEN);
    crypto.getRandomValues(recvSalt);
    const recvKey = hkdf(sha1, masterKey, recvSalt, new TextEncoder().encode('ss-subkey'), KEY_LEN);
    const payload = new TextEncoder().encode('DATA');
    const replyLenPlain = new Uint8Array([(payload.byteLength >> 8) & 0xff, payload.byteLength & 0xff]);
    const replyLenSealed = gcm(recvKey, nonce(0)).encrypt(replyLenPlain);
    const replyPtSealed = gcm(recvKey, nonce(1)).encrypt(payload);
    srv.respond(recvSalt);
    srv.respond(replyLenSealed);
    srv.respond(replyPtSealed);

    const result = await promise;
    const reader = result.readable.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toBe('DATA');
  });

  it('flags an AEAD auth failure on the very first frame as proxy-handshake', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;

    // Drain the dial bytes so the dialer is now reading.
    await srv.read(KEY_LEN);
    await srv.read(2 + 16);
    await srv.read(18 + 16);

    // Reply with a salt + 18 bytes of garbage where the first AEAD frame
    // should be — gcm.decrypt will throw because the tag won't match.
    const recvSalt = new Uint8Array(KEY_LEN);
    crypto.getRandomValues(recvSalt);
    srv.respond(recvSalt);
    srv.respond(new Uint8Array(2 + 16 + 18 + 16)); // all zeros — invalid tag

    const result = await promise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('handshake decrypt'),
    });
  });
});

describe('evpBytesToKey — extended password vectors', () => {
  // Verified externally against OpenSSL's EVP_BytesToKey with no salt:
  //   `openssl enc -aes-128-cbc -k <pwd> -P -nosalt`
  const VECTORS: Array<[string, number, string]> = [
    ['mypassword', 32, '34819d7beeabb9260a5c854bc85b3e44891cbc5868b061227e7afd190187fec7'],
    ['', 16, 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', 16, '0cc175b9c0f1b6a831c399e269772661'],
  ];

  for (const [pwd, len, hex] of VECTORS) {
    it(`derives ${JSON.stringify(pwd)} → ${len * 8}-bit key starting ${hex.slice(0, 8)}…`, () => {
      const got = evpBytesToKey(pwd, len);
      expect(toHex(got)).toBe(hex);
    });
  }

  it('first 16 bytes of the 32-byte chain match the 16-byte derivation (deterministic chaining)', () => {
    const k16 = evpBytesToKey('shadow', 16);
    const k32 = evpBytesToKey('shadow', 32);
    expect(toHex(k16)).toBe(toHex(k32.subarray(0, 16)));
  });
});

describe('HKDF-SHA1 ss-subkey derivation', () => {
  // Computed via Node crypto.hkdfSync; pins down the subkey expansion the
  // dialer uses so a swap to a non-SHA1 HKDF (or a wrong info string) would
  // fail this test immediately.
  it('derives an aes-128-gcm subkey from master "shadow" + zero salt', () => {
    const masterKey = evpBytesToKey('shadow', 16);
    const subkey = hkdf(sha1, masterKey, new Uint8Array(16), new TextEncoder().encode('ss-subkey'), 16);
    expect(toHex(subkey)).toBe('6c050d30cf240cadce2f62148f7e198a');
  });

  it('derives a different subkey when the salt is all-0xff vs all-zero', () => {
    const masterKey = evpBytesToKey('shadow', 16);
    const zeroSalt = new Uint8Array(16);
    const onesSalt = new Uint8Array(16).fill(0xff);
    const k1 = hkdf(sha1, masterKey, zeroSalt, new TextEncoder().encode('ss-subkey'), 16);
    const k2 = hkdf(sha1, masterKey, onesSalt, new TextEncoder().encode('ss-subkey'), 16);
    expect(toHex(k1)).toBe('6c050d30cf240cadce2f62148f7e198a');
    expect(toHex(k2)).toBe('a08c4563c40faabb543fc62304175cf8');
    expect(toHex(k1)).not.toBe(toHex(k2));
  });
});

describe('buildSsAddress — port and host variants', () => {
  it('encodes port 80 as 0x00 0x50', () => {
    const out = buildSsAddress('h', 80);
    expect(out[3]).toBe(0x00);
    expect(out[4]).toBe(0x50);
  });

  it('encodes port 65535 as 0xff 0xff', () => {
    const out = buildSsAddress('h', 65535);
    expect(out[3]).toBe(0xff);
    expect(out[4]).toBe(0xff);
  });

  it('encodes a 255-byte hostname (max ATYP=0x03 dom_len)', () => {
    const host = 'a'.repeat(255);
    const out = buildSsAddress(host, 1);
    expect(out[0]).toBe(0x03);
    expect(out[1]).toBe(0xff);
    expect(new TextDecoder().decode(out.subarray(2, 2 + 255))).toBe(host);
  });

  it('emits ATYP=0x01 + 4 octets for an IPv4 literal target', () => {
    // Reference clients (Xray-core, sing-box) detect the literal shape
    // and emit ATYP=0x01 with the raw 4 octets — sending a literal as a
    // domain string forces an unnecessary string→bytes conversion on
    // the SS server.
    const out = buildSsAddress('1.2.3.4', 80);
    expect(out[0]).toBe(0x01);
    expect(Array.from(out.subarray(1, 5))).toEqual([1, 2, 3, 4]);
    expect(out[5]).toBe(0x00);
    expect(out[6]).toBe(0x50);
    expect(out.byteLength).toBe(1 + 4 + 2);
  });

  it('emits ATYP=0x04 + 16 octets for an unbracketed IPv6 literal target', () => {
    const out = buildSsAddress('::1', 80);
    expect(out[0]).toBe(0x04);
    expect(out[16]).toBe(0x01);
    expect(out[17]).toBe(0x00);
    expect(out[18]).toBe(0x50);
  });

  it('still uses ATYP=0x03 (domain) for a non-literal hostname', () => {
    const out = buildSsAddress('example.com', 80);
    expect(out[0]).toBe(0x03);
    expect(out[1]).toBe(11);
  });
});

describe('dialShadowsocks — salt size matrix', () => {
  // Reference: shadowsocks-rust crates/shadowsocks-crypto/src/v1/cipher.rs.
  // aes-128-gcm uses a 16-byte salt; aes-256-gcm and chacha20-ietf-poly1305
  // both use 32 bytes.
  const CASES: Array<{ method: 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-ietf-poly1305'; saltLen: number }> = [
    { method: 'aes-128-gcm', saltLen: 16 },
    { method: 'aes-256-gcm', saltLen: 32 },
    { method: 'chacha20-ietf-poly1305', saltLen: 32 },
  ];

  for (const { method, saltLen } of CASES) {
    it(`writes ${saltLen}-byte salt prefix for ${method}`, async () => {
      const fake = makeFakeSocketDial();
      void dialShadowsocks(config({ method, password: 'shadow' }), target, { socketDial: fake.socketDial });
      const srv = await fake.awaitConnect();
      const salt = await srv.read(saltLen);
      expect(salt.byteLength).toBe(saltLen);
      // Two independent dials should produce different random salts.
      const fake2 = makeFakeSocketDial();
      void dialShadowsocks(config({ method, password: 'shadow' }), target, { socketDial: fake2.socketDial });
      const srv2 = await fake2.awaitConnect();
      const salt2 = await srv2.read(saltLen);
      expect(Array.from(salt)).not.toEqual(Array.from(salt2));
    });
  }
});

describe('dialShadowsocks — AEAD frame layout', () => {
  it('frames the address record as [encLen(2+16 tag) | encPayload(N+16 tag)] using consecutive nonces', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const TAG_LEN = 16;
    const masterKey = evpBytesToKey('shadow', KEY_LEN);

    const salt = await srv.read(KEY_LEN);
    const subkey = hkdf(sha1, masterKey, salt, new TextEncoder().encode('ss-subkey'), KEY_LEN);
    const lenSealed = await srv.read(2 + TAG_LEN);
    // nonce 0 → len record, nonce 1 → payload record.
    const lenPlain = gcm(subkey, nonce(0)).decrypt(lenSealed);
    expect(lenPlain.byteLength).toBe(2);
    const payloadLen = (lenPlain[0]! << 8) | lenPlain[1]!;
    const ptSealed = await srv.read(payloadLen + TAG_LEN);
    const pt = gcm(subkey, nonce(1)).decrypt(ptSealed);
    expect(pt.byteLength).toBe(payloadLen);
    expect(pt[0]).toBe(0x03); // ATYP=domain

    // Done — let the dialer complete by sending a minimal reply.
    const recvSalt = new Uint8Array(KEY_LEN);
    crypto.getRandomValues(recvSalt);
    const recvSubkey = hkdf(sha1, masterKey, recvSalt, new TextEncoder().encode('ss-subkey'), KEY_LEN);
    const replyLenSealed = gcm(recvSubkey, nonce(0)).encrypt(new Uint8Array([0, 1]));
    const replyPtSealed = gcm(recvSubkey, nonce(1)).encrypt(new Uint8Array([0x42]));
    srv.respond(recvSalt);
    srv.respond(replyLenSealed);
    srv.respond(replyPtSealed);
    await promise;
  });

  it('accumulates payload arriving as many small TCP segments (1 byte at a time)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const masterKey = evpBytesToKey('shadow', KEY_LEN);
    await srv.read(KEY_LEN);
    await srv.read(2 + 16);
    await srv.read(18 + 16);

    const recvSalt = new Uint8Array(KEY_LEN);
    crypto.getRandomValues(recvSalt);
    const recvSubkey = hkdf(sha1, masterKey, recvSalt, new TextEncoder().encode('ss-subkey'), KEY_LEN);
    const payload = new TextEncoder().encode('DATA');
    const lenSealed = gcm(recvSubkey, nonce(0)).encrypt(new Uint8Array([
      (payload.byteLength >> 8) & 0xff,
      payload.byteLength & 0xff,
    ]));
    const ptSealed = gcm(recvSubkey, nonce(1)).encrypt(payload);
    // Drip-feed the salt + records one byte at a time.
    const drip = (b: Uint8Array): void => {
      for (let i = 0; i < b.byteLength; i++) srv.respond(b.subarray(i, i + 1));
    };
    drip(recvSalt);
    drip(lenSealed);
    drip(ptSealed);

    const result = await promise;
    const reader = result.readable.getReader();
    const r = await reader.read();
    expect(new TextDecoder().decode(r.value!)).toBe('DATA');
  });

  it('rejects a length record claiming 0 bytes (payload-len=0 is illegal in AEAD-2018)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const masterKey = evpBytesToKey('shadow', KEY_LEN);
    await srv.read(KEY_LEN);
    await srv.read(2 + 16);
    await srv.read(18 + 16);

    const recvSalt = new Uint8Array(KEY_LEN);
    crypto.getRandomValues(recvSalt);
    const recvSubkey = hkdf(sha1, masterKey, recvSalt, new TextEncoder().encode('ss-subkey'), KEY_LEN);
    // payload len = 0 → bad
    const lenSealed = gcm(recvSubkey, nonce(0)).encrypt(new Uint8Array([0, 0]));
    srv.respond(recvSalt);
    srv.respond(lenSealed);

    const result = await promise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/bad payload length/),
    });
  });

  it('rejects a length record claiming > 0x3fff bytes (cap is the spec maximum)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const masterKey = evpBytesToKey('shadow', KEY_LEN);
    await srv.read(KEY_LEN);
    await srv.read(2 + 16);
    await srv.read(18 + 16);

    const recvSalt = new Uint8Array(KEY_LEN);
    crypto.getRandomValues(recvSalt);
    const recvSubkey = hkdf(sha1, masterKey, recvSalt, new TextEncoder().encode('ss-subkey'), KEY_LEN);
    // payload len = 0x4000 → over the cap
    const lenSealed = gcm(recvSubkey, nonce(0)).encrypt(new Uint8Array([0x40, 0x00]));
    srv.respond(recvSalt);
    srv.respond(lenSealed);

    const result = await promise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/bad payload length 16384/),
    });
  });

  it('errors when the server hangs up before sending the salt', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    await srv.read(KEY_LEN);
    await srv.read(2 + 16);
    await srv.read(18 + 16);
    srv.endResponse();

    const result = await promise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
    });
  });

  it('errors when the server sends a truncated salt (only half of the required bytes)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks(config({ method: 'aes-128-gcm', password: 'shadow' }), target, {
      socketDial: fake.socketDial,
    });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    await srv.read(KEY_LEN);
    await srv.read(2 + 16);
    await srv.read(18 + 16);
    srv.respond(new Uint8Array(8));
    srv.endResponse();

    const result = await promise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
    });
  });
});

describe('dialShadowsocks — pre-handshake plumbing', () => {
  it('classifies tcp-connect failures with the underlying cause', async () => {
    const fake = makeFakeSocketDial();
    fake.failNextConnect(new Error('ECONNREFUSED'));
    await expect(
      dialShadowsocks(config(), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('tcp connect to proxy.example:8388 failed'),
    });
  });
});

describe('dialShadowsocks — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialShadowsocks(config(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
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
      dialShadowsocks(config(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
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
      dialShadowsocks(config(), { host: 'a'.repeat(256), port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('too long'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});

const nonce = (counter: number): Uint8Array => {
  const out = new Uint8Array(12);
  let c = counter;
  for (let i = 0; i < 12; i++) {
    out[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return out;
};

const toHex = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.byteLength; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
};
