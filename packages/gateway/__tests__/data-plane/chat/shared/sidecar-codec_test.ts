import { decode, encode, Tag } from 'cbor-x';
import { describe, expect, it, vi } from 'vitest';

import { createSidecarCodecFactory, encodeCBORValue, SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { decodeForgivingBase64, decodeHex, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';
import { SidecarTaggedValue } from '@floway-dev/translate';

vi.mock('cbor-x', async importOriginal => {
  const actual = await importOriginal<typeof import('cbor-x')>();
  return { ...actual, decode: vi.fn(actual.decode) };
});

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
      0xb9, 0, 2, 0x66, 0x64, 0x6f, 0x6d, 0x61, 0x69, 0x6e, 0,
      0x67, 0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x43, 1, 2, 3,
    ]);
    const signature = decodeHex('7641d53877b66c8c963c02e5f7df2e77ef63ff9c596dc307ec6de1c79889b6d7');
    const expected = encodeBase64(new Uint8Array([...signature, ...data]));
    const encoded = await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload);
    expect(encoded).toBe(expected);
    expect(decodeForgivingBase64(encoded).subarray(0, 32)).toEqual(signature);
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(expected)).toEqual(payload);
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
    const encoded = await Promise.all(payloads.map((payload, index) => codecs[index % 2].codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload)));
    await Promise.all(encoded.map(async (value, index) => {
      expect(decodeForgivingBase64(value).byteLength).toBeGreaterThan(8192);
      expect(await codecs[index % 2].codecFor(SidecarDomain.TranslatedAssistantTurn).decode(value)).toEqual(payloads[index]);
      expect(await codecs[(index + 1) % 2].codecFor(SidecarDomain.TranslatedAssistantTurn).decode(value)).toBeUndefined();
    }));
  });
  it('rejects undefined payloads at encode and after matching authentication', async () => {
    // @ts-expect-error The public encoder excludes undefined payloads.
    await expect(factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(undefined)).rejects.toThrow('Sidecar payload must not be undefined');
    await expect(factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ domain: 0, payload: undefined })))).rejects.toThrow('Authenticated sidecar payload must not be undefined');
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ domain: 1, payload: undefined })))).toBeUndefined();
  });
  it.each([null, false, 0, ''])('returns the decoded payload directly for %j', async payload => {
    const codec = factory.codecFor(SidecarDomain.TranslatedAssistantTurn);
    expect(await codec.decode(await codec.encode(payload))).toBe(payload);
  });
  it('authenticates the expected kind before restoring payload tags', async () => {
    const payload = new Tag(42, 65539);
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ domain: 1, payload })))).toBeUndefined();
    await expect(factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ domain: 0, payload })))).rejects.toThrow('Raw JSON sidecar tag requires a string');
  });
  it('shares pending authentication across kinds until the matching owner takes the payload', async () => {
    const codecs = createSidecarCodecFactory(secret);
    const owner = codecs.codecFor(SidecarDomain.TranslatedAssistantTurn);
    const other = codecs.codecFor(Number(1));
    const payload = { nested: { value: 'original' }, bytes: new Uint8Array([1, 2]) };
    const encoded = await owner.encode(payload);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    try {
      expect(await Promise.all([other.decode(encoded), other.decode(encoded)])).toEqual([undefined, undefined]);
      const first = await owner.decode(encoded);
      expect(first).toEqual(payload);
      expect(verify).toHaveBeenCalledTimes(1);
      const value = record(first);
      record(value.nested).value = 'changed';
      if (!(value.bytes instanceof Uint8Array)) throw new TypeError('Expected bytes');
      value.bytes[0] = 9;
      expect(await owner.decode(encoded)).toEqual(payload);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      verify.mockRestore();
    }
  });
  it('gives concurrent matching callers independently owned payloads', async () => {
    const codecs = createSidecarCodecFactory(secret);
    const owner = codecs.codecFor(SidecarDomain.TranslatedAssistantTurn);
    const other = codecs.codecFor(Number(1));
    const payload = { nested: { value: 'original' } };
    const encoded = await owner.encode(payload);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    try {
      const [foreign, ...results] = await Promise.all([other.decode(encoded), owner.decode(encoded), owner.decode(encoded), owner.decode(encoded)]);
      expect(foreign).toBeUndefined();
      expect(results).toEqual([payload, payload, payload]);
      expect(verify).toHaveBeenCalledTimes(3);
      const first = results[0];
      if (first === undefined) throw new Error('Expected decoded sidecar');
      record(record(first).nested).value = 'changed';
      expect(results.slice(1)).toEqual([payload, payload]);
    } finally {
      verify.mockRestore();
    }
  });
  it('restores the owned decoder payload in place without rebuilding its containers or atomic values', async () => {
    const codec = createSidecarCodecFactory(secret).codecFor(SidecarDomain.TranslatedAssistantTurn);
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const payload = {
      nested: { values: [encodeBase64(bytes), rawJSON.rawJSON('1e400')] },
      bytes,
      unknown: new Tag({ value: new Tag(bytes, 22) }, 65540),
      ...JSON.parse('{"__proto__":{"value":"own property"}}'),
    };
    const encoded = await codec.encode(payload);
    const originalDecode = (await vi.importActual<typeof import('cbor-x')>('cbor-x')).decode;
    let ownedPayload: unknown;
    let ownedNested: unknown;
    let ownedValues: unknown;
    let ownedBytes: unknown;
    let ownedTag: unknown;
    const decoder = vi.mocked(decode).mockImplementation(data => {
      const envelope: unknown = originalDecode(data);
      ownedPayload = record(envelope).payload;
      const body = record(ownedPayload);
      ownedNested = body.nested;
      ownedValues = record(body.nested).values;
      ownedBytes = body.bytes;
      ownedTag = body.unknown;
      return envelope;
    });
    try {
      const restored = await codec.decode(encoded);
      expect(restored).toBe(ownedPayload);
      const body = record(restored);
      expect(body.nested).toBe(ownedNested);
      expect(record(body.nested).values).toBe(ownedValues);
      expect(body.bytes).toBe(ownedBytes);
      expect(body.unknown).toBeInstanceOf(SidecarTaggedValue);
      if (!(body.unknown instanceof SidecarTaggedValue) || !(ownedTag instanceof Tag)) throw new TypeError('Expected an application tag');
      expect(body.unknown.tag).toBe(ownedTag.tag);
      expect(body.unknown.value).toBe(ownedTag.value);
      expect(restored).toEqual(payload);
      expect(Object.hasOwn(body, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    } finally {
      decoder.mockImplementation(originalDecode);
      decoder.mockClear();
    }
  });
  it('borrows encode input without replacing its containers or transformed leaves', async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const base64 = encodeBase64(bytes);
    const number = rawJSON.rawJSON('1e400');
    const values = [base64, number];
    const nested = { values };
    const payload = { nested };
    await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload);
    expect(payload.nested).toBe(nested);
    expect(nested.values).toBe(values);
    expect(values[0]).toBe(base64);
    expect(values[1]).toBe(number);
  });
  it('caches failed authentication within one factory only', async () => {
    const encoded = await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode('value');
    const codecs = createSidecarCodecFactory('another-key');
    const verify = vi.spyOn(crypto.subtle, 'verify');
    try {
      expect(await codecs.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encoded)).toBeUndefined();
      expect(await codecs.codecFor(Number(1)).decode(encoded)).toBeUndefined();
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await createSidecarCodecFactory('another-key').codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encoded)).toBeUndefined();
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      verify.mockRestore();
    }
  });
  it('rejects altered signatures, altered domains, and another secret', async () => {
    const encoded = await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode({ value: 1 });
    const changed = decodeForgivingBase64(encoded);
    changed[changed.length - 1] ^= 1;
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encodeBase64(changed))).toBeUndefined();
    expect(await createSidecarCodecFactory('another-key').codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encoded)).toBeUndefined();
    const envelope = record(decode(decodeForgivingBase64(encoded).subarray(32)));
    const forged = new Uint8Array([...decodeForgivingBase64(encoded).subarray(0, 32), ...encode({ ...envelope, domain: 1 })]);
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encodeBase64(forged))).toBeUndefined();
  });
  it('preserves forgiving outer Base64 decoding', async () => {
    const encoded = await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode('value');
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(` \t${encoded.replaceAll('=', '')}\n`)).toEqual('value');
  });
  it.each(['%', 'A', 'é', 'not!base64'])('rejects unauthenticated invalid Base64 %j', async encoded => {
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encoded)).toBeUndefined();
  });
  it('propagates malformed authenticated CBOR', async () => {
    await expect(factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(new Uint8Array([24])))).rejects.toThrow();
  });
  it('rejects malformed matching envelopes without accepting old unscoped envelopes', async () => {
    await expect(factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ source: 'old', payload: 'value' })))).rejects.toThrow('sidecar domain is invalid');
    await expect(factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ domain: 0 })))).rejects.toThrow('sidecar payload is missing');
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ domain: 1 })))).toBeUndefined();
  });
  it.each(['translate.round-trip', null, true, 0.5, Infinity, NaN])('rejects authenticated invalid domain %j', async domain => {
    await expect(factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await sign(encode({ domain, payload: 'value' })))).rejects.toThrow('sidecar domain is invalid');
  });
  it('preserves unknown CBOR tags for their owner', async () => {
    const payload = { reference: new Tag([[0, 1, 4]], 65536) };
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload))).toEqual(payload);
  });
  it.each([SidecarDomain.TranslatedAssistantTurn, Number(1)])('preserves application tags for kind %s after a foreign decode', async kind => {
    const codecs = createSidecarCodecFactory(secret);
    const owner = codecs.codecFor(kind);
    const other = codecs.codecFor(kind === SidecarDomain.TranslatedAssistantTurn ? Number(1) : SidecarDomain.TranslatedAssistantTurn);
    const payload = {
      text: new SidecarTaggedValue(65536, [0, [1, 2, 5]]),
      nested: [new SidecarTaggedValue(65537, [2])],
      ordinary: { tag: 65536, value: [0] },
    };
    const encoded = await owner.encode(payload);
    const envelope = record(decode(decodeForgivingBase64(encoded).subarray(32)));
    const wire = record(envelope.payload);
    expect(wire.text).toEqual(new Tag([0, [1, 2, 5]], 65536));
    expect(wire.nested).toEqual([new Tag([2], 65537)]);
    expect(await other.decode(encoded)).toBeUndefined();
    const restored = record(await owner.decode(encoded));
    expect(restored).toEqual(payload);
    expect(restored.text).toBeInstanceOf(SidecarTaggedValue);
    if (!Array.isArray(restored.nested)) throw new TypeError('Expected nested references');
    expect(restored.nested[0]).toBeInstanceOf(SidecarTaggedValue);
    expect(restored.ordinary).not.toBeInstanceOf(SidecarTaggedValue);
    if (!(restored.text instanceof SidecarTaggedValue) || !Array.isArray(restored.text.value)) throw new TypeError('Expected an application tag value');
    restored.text.value.push(9);
    expect(await owner.decode(encoded)).toEqual(payload);
  });
  it.each([65536, 65537])('preserves uninterpreted application tag %s payloads', async tag => {
    const codec = factory.codecFor(SidecarDomain.TranslatedAssistantTurn);
    for (const parts of [null, 'reference', [-1], [0.5], [[0, 1]], [[0, 4, 2]], [[0, -1, 2]], [[0, 1, Infinity]]]) {
      const encoded = await sign(encode({ domain: 0, payload: new Tag(parts, tag) }));
      expect(await codec.decode(encoded)).toEqual(new SidecarTaggedValue(tag, parts));
    }
  });
  it('preserves raw numeric tokens and similarly shaped ordinary objects', async () => {
    const tokens = ['9007199254740993', '1e400', '1.2300e+400'];
    const payload = { values: tokens.map(rawJSON.rawJSON), ordinary: { rawJSON: tokens[0] } };
    const decoded = await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload));
    if (decoded === undefined)
      throw new Error('Expected an authenticated sidecar');
    const restored = record(decoded);
    expect(JSON.stringify(restored.values)).toBe(`[${tokens.join(',')}]`);
    expect(rawJSON.isRawJSON(record(restored.ordinary))).toBe(false);
    expect(restored.ordinary).toEqual(payload.ordinary);
    expect([...encodeCBORValue(rawJSON.rawJSON('1e400'))]).toEqual([0xda, 0, 1, 0, 3, 0x65, 0x31, 0x65, 0x34, 0x30, 0x30]);
  });
  it('preserves literal __proto__ keys and ordinary object prototypes', async () => {
    const payload = record(JSON.parse('{"__proto__":{"text":"original"},"__proto_":"separate"}'));
    const decoded = await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload));
    if (decoded === undefined)
      throw new Error('Expected an authenticated sidecar');
    expect(decoded).toEqual(payload);
    expect(Object.hasOwn(record(decoded), '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });
  it('preserves lone-surrogate strings and keys using WTF-8 Tag 273', async () => {
    const mixed = String.fromCodePoint(0x1f600) + String.fromCharCode(0xd800);
    const large = '\u8000'.repeat(3000) + String.fromCharCode(0xd800);
    expect([...encodeCBORValue(String.fromCodePoint(0x1f600))]).toEqual([0x64, 0xf0, 0x9f, 0x98, 0x80]);
    expect([...encodeCBORValue('\ud800')]).toEqual([0xd9, 1, 0x11, 0x43, 0xed, 0xa0, 0x80]);
    expect([...encodeCBORValue(large).subarray(0, 6)]).toEqual([0xd9, 1, 0x11, 0x59, 0x23, 0x2b]);
    const payload = { [mixed]: mixed, large };
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload))).toEqual(payload);
  });
  it('restores canonical Base64 and Base64URL values from their CBOR tags', async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const payload = { base64: encodeBase64(bytes), base64url: encodeBase64url(bytes), nested: [[encodeBase64(bytes), encodeBase64url(bytes)]], short: 'AQID' };
    expect([...encodeCBORValue(payload.base64)]).toEqual([0xd6, 0x50, ...bytes]);
    expect([...encodeCBORValue(payload.base64url)]).toEqual([0xd5, 0x50, ...bytes]);
    expect(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).decode(await factory.codecFor(SidecarDomain.TranslatedAssistantTurn).encode(payload))).toEqual(payload);
  });
});
