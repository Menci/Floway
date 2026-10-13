import { decode, encode, Tag } from 'cbor-x';
import { describe, expect, test } from 'vitest';

import { createTestSidecarCodec as createAssistantTurnSidecarCodec, type RoundTripSidecarPayload } from './sidecar-codec.ts';
import type { RoundTripSidecarEnvelope } from '../../src/round-trip/codec.ts';
import { decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';

const source = 'openaiResponses';
const secret = 'assistant-turn-sidecar-secret';
const codec = createAssistantTurnSidecarCodec(secret);
const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => boolean;
  rawJSON: (text: string) => { readonly rawJSON: string };
};

const sidecarPayload = (providerSpecificFields: Record<string, unknown> = {}): RoundTripSidecarPayload<'openaiChatCompletions'> => ({
  target: 'openaiChatCompletions',
  assistantTurn: { role: 'assistant', content: 'answer', provider_specific_fields: providerSpecificFields },
  replayCheck: { version: 1, digest: new Uint8Array([4, 5, 6]) },
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError('Expected an object');
  return value;
};

const requireArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError('Expected an array');
  return value;
};

const requireTag = (value: unknown): Tag => {
  if (!(value instanceof Tag)) throw new TypeError('Expected a CBOR tag');
  return value;
};

const chatProviderFields = (sidecar: RoundTripSidecarEnvelope): Record<string, unknown> => {
  if (sidecar.target !== 'openaiChatCompletions') throw new TypeError('Expected a Chat Completions sidecar');
  return requireRecord(sidecar.assistantTurn.provider_specific_fields);
};

const tagsIn = (value: unknown): Tag[] => {
  if (value instanceof Tag) return [value];
  if (Array.isArray(value)) return value.flatMap(tagsIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(tagsIn);
};

const hmac = async (data: Uint8Array, value: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, Uint8Array.from(data)));
};

describe('assistant turn sidecar codec', () => {
  test('decodes an independently signed CBOR envelope', async () => {
    const sidecar = {
      target: 'openaiChatCompletions' as const,
      assistantTurn: { role: 'assistant' as const, content: 'answer', reasoning_opaque: 'opaque' },
      replayCheck: { version: 1, digest: new Uint8Array([4, 5, 6]) },
    } satisfies RoundTripSidecarPayload;

    const carrier = await codec.encode(source, sidecar);
    const combined = decodeForgivingBase64(carrier);
    const signature = combined.subarray(0, 32);
    const encodedPayload = combined.subarray(32);
    const expectedPayload = Uint8Array.from(encode({ ...sidecar, source }));

    expect(signature).toHaveLength(32);
    expect(encodedPayload).toEqual(expectedPayload);
    expect(signature).toEqual(await hmac(expectedPayload, secret));
    expect(carrier).toBe(encodeBase64(combined));
    expect(await codec.decode(source, carrier)).toEqual({ ...sidecar, source });
  });

  test('restores branded raw numeric tokens without reinterpreting ordinary objects', async () => {
    const tokens = ['9007199254740993', '1e400', '1.2300e+400'];
    const sidecar = sidecarPayload({ input: { number: rawJSON.rawJSON(tokens[0]) }, values: tokens.map(rawJSON.rawJSON), ordinary: { rawJSON: tokens[0] } });

    const carrier = await codec.encode(source, sidecar);
    const restored = await codec.decode(source, carrier);
    if (restored === undefined) throw new Error('Expected an authenticated sidecar');

    const fields = chatProviderFields(restored);
    const input = requireRecord(fields.input);
    const values = requireArray(fields.values);
    const ordinary = requireRecord(fields.ordinary);
    expect(rawJSON.isRawJSON(input.number)).toBe(true);
    expect(values.map(value => rawJSON.isRawJSON(value))).toEqual([true, true, true]);
    expect(JSON.stringify(values)).toBe(`[${tokens.join(',')}]`);
    expect(rawJSON.isRawJSON(ordinary)).toBe(false);
    expect(ordinary).toEqual({ rawJSON: tokens[0] });
  });

  test('preserves literal __proto__ keys independently of similarly spelled keys', async () => {
    const value = requireRecord(JSON.parse('{"__proto__":{"text":"original"},"__proto_":"separate"}'));
    const sidecar = sidecarPayload({ value });

    const carrier = await codec.encode(source, sidecar);
    const restored = await codec.decode(source, carrier);
    if (restored === undefined) throw new Error('Expected an authenticated sidecar');

    expect(restored).toEqual({ ...sidecar, source });
    const restoredValue = requireRecord(chatProviderFields(restored).value);
    expect(Object.hasOwn(restoredValue, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(restoredValue)).toBe(Object.prototype);
  });

  test('keeps well-formed strings as CBOR text and preserves lone-surrogate strings and keys with Tag 273', async () => {
    const astral = String.fromCodePoint(0x1f600);
    const mixed = astral + String.fromCharCode(0xd800);
    const sidecar = sidecarPayload({ plain: astral, content: mixed, [mixed]: mixed });

    expect([...encode(astral)]).toEqual([0x64, 0xf0, 0x9f, 0x98, 0x80]);
    expect([...encode(mixed)]).toEqual([0xd9, 0x01, 0x11, 0x47, 0xf0, 0x9f, 0x98, 0x80, 0xed, 0xa0, 0x80]);
    expect(decode(Uint8Array.from([0xd9, 0x01, 0x11, 0x41, 0x61]))).toBe('a');
    const large = '\u8000'.repeat(3_000) + String.fromCharCode(0xd800);
    const largeBytes = encode(large);
    expect([...largeBytes.subarray(0, 6)]).toEqual([0xd9, 0x01, 0x11, 0x59, 0x23, 0x2b]);
    expect(decode(largeBytes)).toBe(large);

    const carrier = await codec.encode(source, sidecar);
    const encodedPayload = decodeForgivingBase64(carrier).subarray(32);
    const restored = await codec.decode(source, carrier);
    if (restored === undefined) throw new Error('Expected an authenticated sidecar');
    const decoded = requireRecord(decode(encodedPayload));

    const restoredFields = chatProviderFields(restored);
    const decodedFields = requireRecord(requireRecord(decoded.assistantTurn).provider_specific_fields);
    expect(Object.hasOwn(restoredFields, mixed)).toBe(true);
    expect(restoredFields[mixed]).toBe(mixed);
    expect(restoredFields.content).toBe(mixed);
    expect(restoredFields.plain).toBe(astral);
    expect(Object.hasOwn(decodedFields, mixed)).toBe(true);
    expect(decodedFields[mixed]).toBe(mixed);
  });

  test('decodes canonical Base64 and Base64URL strings from CBOR tags 22 and 21', async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const base64 = encodeBase64(bytes);
    const base64url = encodeBase64url(bytes);
    const shortBase64 = encodeBase64(new Uint8Array([1, 2, 3]));
    const sidecar = sidecarPayload({ base64, base64url, nested: [[base64, base64url]], shortBase64 });

    const carrier = await codec.encode(source, sidecar);
    const decodedPayload = requireRecord(decode(decodeForgivingBase64(carrier).subarray(32)));

    const fields = requireRecord(requireRecord(decodedPayload.assistantTurn).provider_specific_fields);
    expect(fields.base64).toBeInstanceOf(Tag);
    expect(requireTag(fields.base64).tag).toBe(22);
    expect(requireTag(fields.base64).value).toEqual(bytes);
    expect(fields.base64url).toBeInstanceOf(Tag);
    expect(requireTag(fields.base64url).tag).toBe(21);
    expect(requireTag(fields.base64url).value).toEqual(bytes);
    expect(tagsIn(fields.nested)).toEqual([new Tag(bytes, 22), new Tag(bytes, 21)]);
    expect(fields.shortBase64).toBe(shortBase64);
    expect(await codec.decode(source, carrier)).toEqual({ ...sidecar, source });
  });

  test('rejects a modified carrier and a carrier signed by another API key', async () => {
    const carrier = await codec.encode(source, sidecarPayload());
    const changed = decodeForgivingBase64(carrier);
    changed[changed.length - 1] ^= 1;
    const otherCodec = createAssistantTurnSidecarCodec('another-secret');

    expect(await codec.decode(source, encodeBase64(changed))).toBeUndefined();
    expect(await otherCodec.decode(source, carrier)).toBeUndefined();
    expect(await codec.decode('anthropicMessages', carrier)).toBeUndefined();
  });

  test.each(['%', 'A', 'é', 'not!base64'])('rejects unauthenticated invalid base64 %j', async carrier => {
    expect(await codec.decode(source, carrier)).toBeUndefined();
  });

  test('propagates decoding errors in an authenticated payload', async () => {
    const encodedPayload = new Uint8Array([24]);
    const signature = await hmac(encodedPayload, secret);
    const combined = new Uint8Array(signature.length + encodedPayload.length);
    combined.set(signature);
    combined.set(encodedPayload, signature.length);

    await expect(codec.decode(source, encodeBase64(combined))).rejects.toThrow();
  });

  test('rejects an authenticated payload with an invalid sidecar schema', async () => {
    const encodedPayload = Uint8Array.from(encode({ source, target: 'openaiChatCompletions' }));
    const signature = await hmac(encodedPayload, secret);
    const combined = new Uint8Array(signature.length + encodedPayload.length);
    combined.set(signature);
    combined.set(encodedPayload, signature.length);

    await expect(codec.decode(source, encodeBase64(combined))).rejects.toThrow('assistant turn is invalid');
  });
});
