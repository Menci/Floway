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
    srv.endResponse();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
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
    });
  });
});

describe('dialShadowsocks — AEAD frame layout', () => {
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
    });
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
