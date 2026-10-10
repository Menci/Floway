import { decode, encode, Tag } from 'cbor-x';
import { describe, expect, test } from 'vitest';

import { createAssistantTurnSidecarCodec } from '../../../../../src/data-plane/chat/shared/assistant-turn-sidecar/codec.ts';
import { decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';

const source = 'openaiResponses';
const secret = 'assistant-turn-sidecar-secret';
const codec = createAssistantTurnSidecarCodec({ serverSecret: secret });
const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => boolean;
  rawJSON: (text: string) => { readonly rawJSON: string };
};

const hmac = async (data: Uint8Array, value: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as Uint8Array<ArrayBuffer>));
};

describe('assistant turn sidecar codec', () => {
  test('prefixes the CBOR payload with its HMAC-SHA256 signature', async () => {
    const sidecar = {
      source: 'openaiResponses',
      target: 'anthropicMessages',
      referencedContents: [new Uint8Array([1, 2, 3])],
      thinAssistantTurn: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'opaque' }] },
      replayCheck: { version: 1, digest: new Uint8Array([4, 5, 6]) },
    };

    const carrier = await codec.encapsulate(source, sidecar);
    const combined = decodeForgivingBase64(carrier);
    const signature = combined.subarray(0, 32);
    const payload = combined.subarray(32);
    const expectedPayload = Uint8Array.from(encode(sidecar));

    expect(payload).toEqual(expectedPayload);
    expect(signature).toEqual(await hmac(expectedPayload, secret));
    expect(carrier).toBe(encodeBase64(combined));
    expect(await codec.unencapsulate(source, carrier)).toEqual(sidecar);
  });

  test('preserves the bytes inside a typed-array view', async () => {
    const backing = new Uint8Array([255, 1, 2, 3, 254]);
    const byteView = backing.subarray(1, 4);

    const carrier = await codec.encapsulate(source, { referencedContents: [byteView] });

    expect(await codec.unencapsulate(source, carrier)).toEqual({ source, referencedContents: [new Uint8Array([1, 2, 3])] });
  });

  test('preserves thin reference Tags in objects and nested arrays', async () => {
    const textReference = new Tag([0, [1, 2, 4]], 65_536);
    const jsonReference = new Tag([1], 65_537);
    const sidecar = { source, thinAssistantTurn: [textReference, { input: jsonReference }, [[textReference]]] };

    const carrier = await codec.encapsulate(source, sidecar);
    const restored = await codec.unencapsulate(source, carrier) as typeof sidecar;

    expect(restored).toEqual(sidecar);
    expect(restored.thinAssistantTurn[0]).toBeInstanceOf(Tag);
    expect((restored.thinAssistantTurn[1] as { input: Tag }).input).toBeInstanceOf(Tag);
    expect((restored.thinAssistantTurn[2] as Tag[][])[0][0]).toBeInstanceOf(Tag);
  });

  test('restores branded raw numeric tokens without reinterpreting ordinary objects', async () => {
    const tokens = ['9007199254740993', '1e400', '1.2300e+400'];
    const sidecar = { source, input: { number: rawJSON.rawJSON(tokens[0]) }, values: tokens.map(rawJSON.rawJSON), ordinary: { rawJSON: tokens[0] } };

    const carrier = await codec.encapsulate(source, sidecar);
    const restored = await codec.unencapsulate(source, carrier) as typeof sidecar;

    expect(rawJSON.isRawJSON(restored.input.number)).toBe(true);
    expect(restored.values.map(value => rawJSON.isRawJSON(value))).toEqual([true, true, true]);
    expect(JSON.stringify(restored.values)).toBe(`[${tokens.join(',')}]`);
    expect(rawJSON.isRawJSON(restored.ordinary)).toBe(false);
    expect(restored.ordinary).toEqual(sidecar.ordinary);
  });

  test('preserves literal __proto__ keys independently of similarly spelled keys', async () => {
    const value = JSON.parse('{"__proto__":{"text":"original"},"__proto_":"separate"}') as Record<string, unknown>;
    const sidecar = { source, thinAssistantTurn: [value] };

    const carrier = await codec.encapsulate(source, sidecar);
    const restored = await codec.unencapsulate(source, carrier) as typeof sidecar;

    expect(restored).toEqual(sidecar);
    expect(Object.hasOwn(restored.thinAssistantTurn[0], '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(restored.thinAssistantTurn[0])).toBe(Object.prototype);
  });

  test('keeps well-formed strings as CBOR text and preserves lone-surrogate strings and keys with Tag 273', async () => {
    const astral = String.fromCodePoint(0x1f600);
    const mixed = astral + String.fromCharCode(0xd800);
    const sidecar = { source, plain: astral, content: mixed, [mixed]: mixed };

    expect([...encode(astral)]).toEqual([0x64, 0xf0, 0x9f, 0x98, 0x80]);
    expect([...encode(mixed)]).toEqual([0xd9, 0x01, 0x11, 0x47, 0xf0, 0x9f, 0x98, 0x80, 0xed, 0xa0, 0x80]);
    expect(decode(Uint8Array.from([0xd9, 0x01, 0x11, 0x41, 0x61]))).toBe('a');
    const large = '\u8000'.repeat(3_000) + String.fromCharCode(0xd800);
    const largeBytes = encode(large);
    expect([...largeBytes.subarray(0, 6)]).toEqual([0xd9, 0x01, 0x11, 0x59, 0x23, 0x2b]);
    expect(decode(largeBytes)).toBe(large);

    const carrier = await codec.encapsulate(source, sidecar);
    const payload = decodeForgivingBase64(carrier).subarray(32);
    const restored = await codec.unencapsulate(source, carrier) as typeof sidecar;
    const decoded = decode(payload) as typeof sidecar;

    expect(Object.hasOwn(restored, mixed)).toBe(true);
    expect(restored[mixed]).toBe(mixed);
    expect(restored.content).toBe(mixed);
    expect(restored.plain).toBe(astral);
    expect(Object.hasOwn(decoded, mixed)).toBe(true);
    expect(decoded[mixed]).toBe(mixed);
  });

  test('packs canonical Base64 and Base64URL strings as CBOR tags 22 and 21', async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const base64 = encodeBase64(bytes);
    const base64url = encodeBase64url(bytes);
    const shortBase64 = encodeBase64(new Uint8Array([1, 2, 3]));
    const sidecar = { base64, base64url, shortBase64, source };

    const carrier = await codec.encapsulate(source, sidecar);
    const payload = decode(decodeForgivingBase64(carrier).subarray(32)) as Record<string, unknown>;

    expect(payload.base64).toBeInstanceOf(Tag);
    expect((payload.base64 as Tag).tag).toBe(22);
    expect((payload.base64 as Tag).value).toEqual(bytes);
    expect(payload.base64url).toBeInstanceOf(Tag);
    expect((payload.base64url as Tag).tag).toBe(21);
    expect((payload.base64url as Tag).value).toEqual(bytes);
    expect(payload.shortBase64).toBe(shortBase64);
    expect(await codec.unencapsulate(source, carrier)).toEqual(sidecar);
  });

  test('rejects a modified carrier and a carrier signed by another API key', async () => {
    const carrier = await codec.encapsulate(source, { items: [{ type: 'message', text: 'answer' }] });
    const changed = decodeForgivingBase64(carrier);
    changed[changed.length - 1] ^= 1;
    const otherCodec = createAssistantTurnSidecarCodec({ serverSecret: 'another-secret' });

    expect(await codec.unencapsulate(source, encodeBase64(changed))).toBeUndefined();
    expect(await otherCodec.unencapsulate(source, carrier)).toBeUndefined();
    expect(await codec.unencapsulate(source, undefined)).toBeUndefined();
    expect(await codec.unencapsulate('anthropicMessages', carrier)).toBeUndefined();
  });

  test('returns undefined when an authenticated payload is not valid CBOR', async () => {
    const payload = new Uint8Array([24]);
    const signature = await hmac(payload, secret);
    const combined = new Uint8Array(signature.length + payload.length);
    combined.set(signature);
    combined.set(payload, signature.length);

    expect(await codec.unencapsulate(source, encodeBase64(combined))).toBeUndefined();
  });
});
