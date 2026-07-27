import { gcm } from '@noble/ciphers/aes.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { describe, expect, it } from 'vitest';

import { concat } from '../../src/bytes.ts';
import { buildSs2022RequestHeader, dialShadowsocks2022 } from '../../src/protocols/shadowsocks-2022.ts';
import type { Shadowsocks2022ProxyConfig } from '../../src/proxy-config.ts';
import type { DialTarget } from '../../src/types.ts';
import { makeFakeSocketDial, type FakeServer } from '../test-utils/fake-socket-dial.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };

// 16-byte PSK encoded as base64 — required key length for blake3-aes-128-gcm.
const PSK_BYTES = new Uint8Array(Array.from({ length: 16 }, (_, i) => i + 1));
const PSK_B64 = btoa(String.fromCharCode(...PSK_BYTES));

const config = (overrides: Partial<Shadowsocks2022ProxyConfig> = {}): Shadowsocks2022ProxyConfig => ({
  kind: 'ss2022',
  method: '2022-blake3-aes-128-gcm',
  passwordBase64: PSK_B64,
  host: 'proxy.example',
  port: 8388,
  name: 'ss2022',
  ...overrides,
});

const SUBKEY_CONTEXT = new TextEncoder().encode('shadowsocks 2022 session subkey');

describe('buildSs2022RequestHeader', () => {
  it('encodes ATYP=0x03 | dom_len | dom | port BE | padlen=16 | 16-byte pad', () => {
    const h = buildSs2022RequestHeader('api.openai.com', 443);
    let off = 0;
    expect(h[off++]).toBe(0x03);
    expect(h[off++]).toBe(14);
    expect(new TextDecoder().decode(h.subarray(off, off + 14))).toBe('api.openai.com');
    off += 14;
    expect(h[off++]).toBe(0x01);
    expect(h[off++]).toBe(0xbb);
    expect(h[off++]).toBe(0x00);
    expect(h[off++]).toBe(0x10);
    // 16 padding bytes follow; we don't assert their values (random) but the
    // total length is fixed.
    expect(h.byteLength).toBe(off + 16);
  });

  it('emits ATYP=0x01 + 4 octets for an IPv4 literal target', () => {
    // Reference: Xray-core transport/internet/sockopt parses literals up
    // front and emits the SOCKS5 ATYP=0x01 byte sequence; sending a
    // literal as a domain would force a string→bytes conversion on the
    // far side. Layout: ATYP(1) | v4(4) | port(2) | padlen(2) | pad(16) = 25 bytes.
    const h = buildSs2022RequestHeader('1.2.3.4', 80);
    expect(h[0]).toBe(0x01);
    expect(Array.from(h.subarray(1, 5))).toEqual([1, 2, 3, 4]);
    expect(h[5]).toBe(0x00); expect(h[6]).toBe(0x50);
    expect(h[7]).toBe(0x00); expect(h[8]).toBe(0x10);
    expect(h.byteLength).toBe(1 + 4 + 2 + 2 + 16);
  });

  it('still uses ATYP=0x03 (domain) for a non-literal hostname', () => {
    const h = buildSs2022RequestHeader('example.com', 80);
    expect(h[0]).toBe(0x03);
    expect(h[1]).toBe(11);
  });
});

describe('dialShadowsocks2022 — SIP022 happy path', () => {
  it('completes when server echoes the salt and responds within the ±30s window', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const TAG = 16;

    const sendSalt = await srv.read(KEY_LEN);
    const sendKey = blake3(concat(PSK_BYTES, sendSalt), { dkLen: KEY_LEN, context: SUBKEY_CONTEXT });
    const fixedSealed = await srv.read(1 + 8 + 2 + TAG);
    const fixedPlain = gcm(sendKey, nonce(0)).decrypt(fixedSealed);
    expect(fixedPlain[0]).toBe(0x00); // request type
    const variableLen = (fixedPlain[9]! << 8) | fixedPlain[10]!;
    const variableSealed = await srv.read(variableLen + TAG);
    const variablePlain = gcm(sendKey, nonce(1)).decrypt(variableSealed);
    expect(variablePlain[0]).toBe(0x03);
    expect(variablePlain[1]).toBe(14);
    expect(new TextDecoder().decode(variablePlain.subarray(2, 16))).toBe('api.openai.com');
    expect(variablePlain[16]).toBe(0x01);
    expect(variablePlain[17]).toBe(0xbb);

    // Server reply.
    sendServerHandshake(srv, sendSalt, KEY_LEN, /* skewSec */ 0, 'OK');

    const result = await promise;
    const reader = result.readable.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toBe('OK');
  });
});

describe('dialShadowsocks2022 — SIP022 defenses', () => {
  it('rejects a response whose timestamp is more than 30s in the past', async () => {
    await expect(runWithServerHandshakeOptions({ skewSec: 31, echoCorrect: true })).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/timestamp skew/),
    });
  });

  it('rejects a response whose timestamp is more than 30s in the future', async () => {
    await expect(runWithServerHandshakeOptions({ skewSec: -31, echoCorrect: true })).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/timestamp skew/),
    });
  });

  it('rejects a response whose salt-echo does not match our request salt', async () => {
    await expect(runWithServerHandshakeOptions({ skewSec: 0, echoCorrect: false })).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/salt-echo mismatch/),
    });
  });
});

describe('dialShadowsocks2022 — pre-connect config validation', () => {
  // Pre-connect failures must surface as ProxyDialError so the caller's
  // fallback chain still triggers.
  it('rejects an unparseable PSK base64 string as a typed dial error', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialShadowsocks2022(config({ passwordBase64: 'not!valid!base64' }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('invalid base64'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a PSK whose decoded byte length disagrees with the cipher', async () => {
    const fake = makeFakeSocketDial();
    // 2022-blake3-aes-128-gcm wants 16 bytes; a 15-byte PSK fails up-front.
    const shortPsk = btoa(String.fromCharCode(...new Uint8Array(15)));
    await expect(
      dialShadowsocks2022(config({ passwordBase64: shortPsk }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('PSK is 15 bytes'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a 17-byte PSK for aes-128-gcm (too long)', async () => {
    const fake = makeFakeSocketDial();
    const tooLongPsk = btoa(String.fromCharCode(...new Uint8Array(17)));
    await expect(
      dialShadowsocks2022(config({ passwordBase64: tooLongPsk }), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('PSK is 17 bytes'),
    });
  });

  it('rejects a 16-byte PSK for aes-256-gcm (wrong length for the cipher)', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialShadowsocks2022(
        config({ method: '2022-blake3-aes-256-gcm', passwordBase64: PSK_B64 }),
        target,
        { socketDial: fake.socketDial },
      ),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('PSK is 16 bytes'),
    });
  });

  it('accepts a 32-byte PSK for the chacha20 method', async () => {
    const fake = makeFakeSocketDial();
    const psk32 = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x42)));
    // Construct and abandon — we don't need a full handshake, just confirm
    // pre-connect validation passes through to the connect step.
    void dialShadowsocks2022(
      config({ method: '2022-blake3-chacha20-poly1305', passwordBase64: psk32 }),
      target,
      { socketDial: fake.socketDial },
    );
    await fake.awaitConnect();
    expect(fake.connectCount()).toBe(1);
  });
});

describe('dialShadowsocks2022 — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialShadowsocks2022(config(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
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
      dialShadowsocks2022(config(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
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
      dialShadowsocks2022(config(), { host: 'a'.repeat(256), port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('too long'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});

describe('dialShadowsocks2022 — request header layout', () => {
  // SIP022 fixed header: type(1) + timestamp(u64 BE) + variable-len(u16 BE),
  // sealed under nonce=0. Variable header: SOCKS-like address + padlen(u16) +
  // pad + initial_payload, sealed under nonce=1.
  it('writes salt | sealed-fixed | sealed-variable in one TCP segment', async () => {
    const fake = makeFakeSocketDial();
    void dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const TAG = 16;
    // Fixed sealed = 11 (plain) + tag = 27 bytes. Variable plain length is
    // 1+1+14+2+2+16 = 36; sealed = 36 + tag = 52 bytes.
    const total = KEY_LEN + (11 + TAG) + (36 + TAG);
    // The dialer should have buffered everything up; allow up to a few
    // microticks for the WritableStream to flush.
    await new Promise(r => setTimeout(r, 0));
    expect(srv.peekWritten().byteLength).toBe(total);
  });

  it('encodes type=0x00 (REQUEST) in the fixed header', async () => {
    const fake = makeFakeSocketDial();
    void dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const sendSalt = await srv.read(KEY_LEN);
    const sendKey = blake3(concat(PSK_BYTES, sendSalt), { dkLen: KEY_LEN, context: SUBKEY_CONTEXT });
    const fixedSealed = await srv.read(11 + 16);
    const fixedPlain = gcm(sendKey, nonce(0)).decrypt(fixedSealed);
    expect(fixedPlain[0]).toBe(0x00);
  });

  it('emits a timestamp within ±5s of the dial wall clock', async () => {
    const before = Math.floor(Date.now() / 1000);
    const fake = makeFakeSocketDial();
    void dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const sendSalt = await srv.read(KEY_LEN);
    const sendKey = blake3(concat(PSK_BYTES, sendSalt), { dkLen: KEY_LEN, context: SUBKEY_CONTEXT });
    const fixedSealed = await srv.read(11 + 16);
    const fixedPlain = gcm(sendKey, nonce(0)).decrypt(fixedSealed);
    const after = Math.floor(Date.now() / 1000);
    let ts = 0n;
    for (let i = 0; i < 8; i++) ts = (ts << 8n) | BigInt(fixedPlain[1 + i]!);
    const tsN = Number(ts);
    expect(tsN).toBeGreaterThanOrEqual(before - 1);
    expect(tsN).toBeLessThanOrEqual(after + 1);
  });

  it('emits 16 random padding bytes in the variable header (padlen field = 0x0010)', async () => {
    const fake = makeFakeSocketDial();
    void dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const KEY_LEN = 16;
    const sendSalt = await srv.read(KEY_LEN);
    const sendKey = blake3(concat(PSK_BYTES, sendSalt), { dkLen: KEY_LEN, context: SUBKEY_CONTEXT });
    await srv.read(11 + 16);
    const variableSealed = await srv.read(36 + 16);
    const variablePlain = gcm(sendKey, nonce(1)).decrypt(variableSealed);
    // padlen lives at offset 2+14+2 = 18.
    expect(variablePlain[18]).toBe(0x00);
    expect(variablePlain[19]).toBe(0x10);
    expect(variablePlain.byteLength).toBe(36);
  });
});

describe('dialShadowsocks2022 — KDF + key-length matrix', () => {
  // SIP022 keys are derived via blake3.derive_key over PSK||salt under the
  // fixed context "shadowsocks 2022 session subkey", to the cipher's key
  // length. We rederive on the test side and assert byte-equality.
  it('derives a 16-byte key for aes-128-gcm with our context', () => {
    const psk = new Uint8Array(16).fill(0x11);
    const salt = new Uint8Array(16).fill(0x22);
    const key = blake3(concat(psk, salt), { dkLen: 16, context: SUBKEY_CONTEXT });
    // Pin the derived key to a golden vector so a primitive swap or a drift in
    // the SUBKEY_CONTEXT string is caught here, not only at round-trip.
    expect(Array.from(key).map(b => b.toString(16).padStart(2, '0')).join(''))
      .toBe('5f5af8d1711a0cf862c59d7ebe86365f');
  });

  it('derives a 32-byte key for aes-256-gcm', () => {
    const psk = new Uint8Array(32).fill(0xab);
    const salt = new Uint8Array(32).fill(0xcd);
    const key = blake3(concat(psk, salt), { dkLen: 32, context: SUBKEY_CONTEXT });
    expect(key.byteLength).toBe(32);
  });

  it('produces a different subkey for a different salt under the same PSK', () => {
    const psk = new Uint8Array(16).fill(0x11);
    const k1 = blake3(concat(psk, new Uint8Array(16).fill(0x01)), { dkLen: 16, context: SUBKEY_CONTEXT });
    const k2 = blake3(concat(psk, new Uint8Array(16).fill(0x02)), { dkLen: 16, context: SUBKEY_CONTEXT });
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
  });
});

describe('dialShadowsocks2022 — response-side SIP022 checks', () => {
  it('rejects a response whose timestamp is exactly 0 (epoch)', async () => {
    // skew = now - 0 = now (huge) → outside the ±30s window.
    await expect(runWithServerHandshakeOptions({ skewSec: Math.floor(Date.now() / 1000), echoCorrect: true })).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/timestamp skew/),
    });
  });

  it('accepts a response exactly 30s in the past (boundary inclusive)', async () => {
    const r = await runWithServerHandshakeOptions({ skewSec: 30, echoCorrect: true });
    expect(new TextDecoder().decode((r as { value: Uint8Array }).value)).toBe('OK');
  });

  it('accepts a response exactly 30s in the future (boundary inclusive)', async () => {
    const r = await runWithServerHandshakeOptions({ skewSec: -30, echoCorrect: true });
    expect(new TextDecoder().decode((r as { value: Uint8Array }).value)).toBe('OK');
  });
});

const runWithServerHandshakeOptions = async (
  serverOpts: { skewSec: number; echoCorrect: boolean },
): Promise<unknown> => {
  const fake = makeFakeSocketDial();
  const dialPromise = dialShadowsocks2022(config(), target, { socketDial: fake.socketDial });
  const srv = await fake.awaitConnect();
  const KEY_LEN = 16;
  const TAG = 16;

  // Drain the dial side so the dialer is now waiting on us.
  const sendSalt = await srv.read(KEY_LEN);
  await srv.read(1 + 8 + 2 + TAG);
  // Drain the variable-header AEAD record (we don't decrypt it; the dialer
  // wrote everything in one shot, so just consume what's still buffered).
  const remaining = srv.peekWritten().byteLength;
  if (remaining > 0) await srv.read(remaining);

  const dialerSendSalt = serverOpts.echoCorrect ? sendSalt : new Uint8Array(KEY_LEN);
  sendServerHandshake(srv, dialerSendSalt, KEY_LEN, serverOpts.skewSec, 'OK');

  const result = await dialPromise;
  const reader = result.readable.getReader();
  return await reader.read();
};

const sendServerHandshake = (
  srv: FakeServer,
  sendSaltToEcho: Uint8Array,
  keyLen: number,
  skewSec: number,
  payload: string,
): void => {
  const recvSalt = new Uint8Array(keyLen);
  crypto.getRandomValues(recvSalt);
  const recvKey = blake3(concat(PSK_BYTES, recvSalt), { dkLen: keyLen, context: SUBKEY_CONTEXT });
  let recvNonce = 0n;

  // Response fixed header: type=0x01 | timestamp(u64be) | salt-echo(keyLen) | first_payload_len(u16be) + tag.
  const respTs = BigInt(Math.floor(Date.now() / 1000)) - BigInt(skewSec);
  const fixedPlain = new Uint8Array(1 + 8 + keyLen + 2);
  fixedPlain[0] = 0x01;
  for (let i = 7; i >= 0; i--) {
    fixedPlain[1 + i] = Number(respTs >> BigInt((7 - i) * 8) & 0xffn);
  }
  fixedPlain.set(sendSaltToEcho, 1 + 8);
  const payloadBytes = new TextEncoder().encode(payload);
  fixedPlain[1 + 8 + keyLen] = (payloadBytes.byteLength >> 8) & 0xff;
  fixedPlain[1 + 8 + keyLen + 1] = payloadBytes.byteLength & 0xff;
  const fixedSealed = gcm(recvKey, nonce(Number(recvNonce++))).encrypt(fixedPlain);
  const payloadSealed = gcm(recvKey, nonce(Number(recvNonce++))).encrypt(payloadBytes);

  const out = new Uint8Array(keyLen + fixedSealed.byteLength + payloadSealed.byteLength);
  out.set(recvSalt, 0);
  out.set(fixedSealed, keyLen);
  out.set(payloadSealed, keyLen + fixedSealed.byteLength);
  srv.respond(out);
};

const nonce = (counter: number): Uint8Array => {
  const out = new Uint8Array(12);
  let c = counter;
  for (let i = 0; i < 12; i++) {
    out[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return out;
};
