import { decode, encode, Tag } from 'cbor-x';
import { describe, expect, it } from 'vitest';

import { createSidecarCodecFactory, encodeCBORValue, SidecarKind } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { decodeForgivingBase64, decodeHex, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';
const secret = 'key';
const factory = createSidecarCodecFactory(secret);
const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => boolean;
  rawJSON: (text: string) => {
    readonly rawJSON: string;
  };
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value))
    throw new TypeError('Expected an object');
  return value;
};
const sign = async (data: Uint8Array): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, Uint8Array.from(data)));
  return encodeBase64(new Uint8Array([...signature, ...data]));
};
describe('signed CBOR sidecars', () => {
  it('matches an independent CBOR and HMAC-SHA256 wire vector', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const data = new Uint8Array([
      0xb9, 0, 2, 0x64, 0x6b, 0x69, 0x6e, 0x64, 0,
      0x67, 0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x43, 1, 2, 3,
    ]);
    const signature = decodeHex('afafeb8a52e65e638fe349d536a073e632c5c4959f53b60a568f0f1900e43177');
    const expected = encodeBase64(new Uint8Array([...signature, ...data]));
    const encoded = await factory.getForKind(SidecarKind.TranslateRoundTrip).encode(payload);
    expect(encoded).toBe(expected);
    expect(decodeForgivingBase64(encoded).subarray(0, 32)).toEqual(signature);
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(expected)).toEqual({ payload });
  });
  it('encodes native byte strings and plain maps without typed-array or record tags', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...encodeCBORValue(bytes)]).toEqual([0x48, ...bytes]);
    expect([...encodeCBORValue([{ x: 'a' }, { x: 'b' }])]).toEqual([
      0x82, 0xb9, 0, 1, 0x61, 0x78, 0x61, 0x61,
      0xb9, 0, 1, 0x61, 0x78, 0x61, 0x62,
    ]);
  });
  it('isolates concurrent encodes across shared buffer allocations and signing keys', async () => {
    const codecs = [createSidecarCodecFactory('first-key'), createSidecarCodecFactory('second-key')];
    const payloads = Array.from({ length: 32 }, (_, index) => ({ index, text: `Payload ${index}. `.repeat(900 + index * 10) }));
    const encoded = await Promise.all(payloads.map((payload, index) => codecs[index % 2].getForKind(SidecarKind.TranslateRoundTrip).encode(payload)));
    await Promise.all(encoded.map(async (value, index) => {
      expect(decodeForgivingBase64(value).byteLength).toBeGreaterThan(8192);
      expect(await codecs[index % 2].getForKind(SidecarKind.TranslateRoundTrip).decode(value)).toEqual({ payload: payloads[index] });
      expect(await codecs[(index + 1) % 2].getForKind(SidecarKind.TranslateRoundTrip).decode(value)).toBeUndefined();
    }));
  });
  it('distinguishes an authenticated undefined payload from a foreign sidecar', async () => {
    const encoded = await factory.getForKind(SidecarKind.TranslateRoundTrip).encode(undefined);
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(encoded)).toEqual({ payload: undefined });
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(encode({ kind: 1, payload: undefined })))).toBeUndefined();
  });
  it('authenticates the expected kind before restoring payload tags', async () => {
    const payload = new Tag(42, 65539);
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(encode({ kind: 1, payload })))).toBeUndefined();
    await expect(factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(encode({ kind: 0, payload })))).rejects.toThrow('Raw JSON sidecar tag requires a string');
  });
  it('rejects altered signatures, altered kinds, and another secret', async () => {
    const encoded = await factory.getForKind(SidecarKind.TranslateRoundTrip).encode({ value: 1 });
    const changed = decodeForgivingBase64(encoded);
    changed[changed.length - 1] ^= 1;
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(encodeBase64(changed))).toBeUndefined();
    expect(await createSidecarCodecFactory('another-key').getForKind(SidecarKind.TranslateRoundTrip).decode(encoded)).toBeUndefined();
    const envelope = record(decode(decodeForgivingBase64(encoded).subarray(32)));
    const forged = new Uint8Array([...decodeForgivingBase64(encoded).subarray(0, 32), ...encode({ ...envelope, kind: 1 })]);
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(encodeBase64(forged))).toBeUndefined();
  });
  it('preserves forgiving outer Base64 decoding', async () => {
    const encoded = await factory.getForKind(SidecarKind.TranslateRoundTrip).encode('value');
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(` \t${encoded.replaceAll('=', '')}\n`)).toEqual({ payload: 'value' });
  });
  it.each(['%', 'A', 'é', 'not!base64'])('rejects unauthenticated invalid Base64 %j', async encoded => {
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(encoded)).toBeUndefined();
  });
  it('propagates malformed authenticated CBOR', async () => {
    await expect(factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(new Uint8Array([24])))).rejects.toThrow();
  });
  it('rejects malformed matching envelopes without accepting old unscoped envelopes', async () => {
    await expect(factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(encode({ source: 'old', payload: 'value' })))).rejects.toThrow('sidecar kind is invalid');
    await expect(factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(encode({ kind: 0 })))).rejects.toThrow('sidecar payload is missing');
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(encode({ kind: 1 })))).toBeUndefined();
  });
  it.each(['translate.round-trip', null, true, 0.5, Infinity, NaN])('rejects authenticated invalid kind %j', async kind => {
    await expect(factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await sign(encode({ kind, payload: 'value' })))).rejects.toThrow('sidecar kind is invalid');
  });
  it('preserves unknown CBOR tags for their owner', async () => {
    const payload = { reference: new Tag([[0, 1, 4]], 65536) };
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await factory.getForKind(SidecarKind.TranslateRoundTrip).encode(payload))).toEqual({ payload });
  });
  it('preserves raw numeric tokens and similarly shaped ordinary objects', async () => {
    const tokens = ['9007199254740993', '1e400', '1.2300e+400'];
    const payload = { values: tokens.map(rawJSON.rawJSON), ordinary: { rawJSON: tokens[0] } };
    const decoded = await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await factory.getForKind(SidecarKind.TranslateRoundTrip).encode(payload));
    if (decoded === undefined)
      throw new Error('Expected an authenticated sidecar');
    const restored = record(decoded.payload);
    expect(JSON.stringify(restored.values)).toBe(`[${tokens.join(',')}]`);
    expect(rawJSON.isRawJSON(record(restored.ordinary))).toBe(false);
    expect(restored.ordinary).toEqual(payload.ordinary);
    expect([...encodeCBORValue(rawJSON.rawJSON('1e400'))]).toEqual([0xda, 0, 1, 0, 3, 0x65, 0x31, 0x65, 0x34, 0x30, 0x30]);
  });
  it('preserves literal __proto__ keys and ordinary object prototypes', async () => {
    const payload = record(JSON.parse('{"__proto__":{"text":"original"},"__proto_":"separate"}'));
    const decoded = await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await factory.getForKind(SidecarKind.TranslateRoundTrip).encode(payload));
    if (decoded === undefined)
      throw new Error('Expected an authenticated sidecar');
    expect(decoded.payload).toEqual(payload);
    expect(Object.hasOwn(record(decoded.payload), '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(decoded.payload)).toBe(Object.prototype);
  });
  it('preserves lone-surrogate strings and keys using WTF-8 Tag 273', async () => {
    const mixed = String.fromCodePoint(0x1f600) + String.fromCharCode(0xd800);
    const large = '\u8000'.repeat(3000) + String.fromCharCode(0xd800);
    expect([...encodeCBORValue(String.fromCodePoint(0x1f600))]).toEqual([0x64, 0xf0, 0x9f, 0x98, 0x80]);
    expect([...encodeCBORValue('\ud800')]).toEqual([0xd9, 1, 0x11, 0x43, 0xed, 0xa0, 0x80]);
    expect([...encodeCBORValue(large).subarray(0, 6)]).toEqual([0xd9, 1, 0x11, 0x59, 0x23, 0x2b]);
    const payload = { [mixed]: mixed, large };
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await factory.getForKind(SidecarKind.TranslateRoundTrip).encode(payload))).toEqual({ payload });
  });
  it('restores canonical Base64 and Base64URL values from their CBOR tags', async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const payload = { base64: encodeBase64(bytes), base64url: encodeBase64url(bytes), nested: [[encodeBase64(bytes), encodeBase64url(bytes)]], short: 'AQID' };
    expect([...encodeCBORValue(payload.base64)]).toEqual([0xd6, 0x50, ...bytes]);
    expect([...encodeCBORValue(payload.base64url)]).toEqual([0xd5, 0x50, ...bytes]);
    expect(await factory.getForKind(SidecarKind.TranslateRoundTrip).decode(await factory.getForKind(SidecarKind.TranslateRoundTrip).encode(payload))).toEqual({ payload });
  });
});
