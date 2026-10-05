import { decode, Tag } from 'cbor-x';
import { expect, test } from 'vitest';

import { createOpenAIChatCompletionsPrivateCodec } from '../../../../../src/data-plane/chat/shared/assistant-message-private/codec.ts';
import { decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantMessagePrivate } from '@floway-dev/protocols/openai-chat-completions';

const codec = createOpenAIChatCompletionsPrivateCodec({ serverSecret: 'first-key' });
const value = (): OpenAIChatCompletionsAssistantMessagePrivate => ({
  reasoningText: '思考🙂',
  sidecar: {
    upstreamProtocol: 'openaiChatCompletions',
    textFieldOriginalName: 'reasoning_content',
    extraFields: {
      reasoning_text: 'another field',
      reasoning_details: JSON.parse('{"__proto__":{"value":1},"__proto_":2,"nested":[{"signature":"/wD/Af8C/wP/BP8F/wb/B/8I/wn/Cv8L"},{"signature":"_wD_Af8C_wP_BP8F_wb_B_8I_wn_Cv8L"}]}') as unknown,
    },
    toolCallExtraFields: { call_1: { extra_content: { google: { thought_signature: 'opaque signature' } } } },
  },
});

test('authenticated assistant replay data preserves fields, nested base64 forms, and literal JSON keys', async () => {
  const input = value();
  const carrier = await codec.encapsulate(input);
  const restored = await codec.unencapsulate(carrier);
  expect(restored).toEqual(input);
  const fields = restored?.sidecar.upstreamProtocol === 'openaiChatCompletions' ? restored.sidecar.extraFields : undefined;
  expect(Object.hasOwn(fields?.reasoning_details as object, '__proto__')).toBe(true);
  expect(Object.hasOwn(Object.prototype, 'value')).toBe(false);
});

test('assistant codec preserves canonical base64 and base64url strings across the compression threshold', async () => {
  const strings = Array.from({ length: 40 }, (_, size) => {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 71 + 255) % 256);
    return [encodeBase64(bytes), encodeBase64url(bytes)];
  }).flat();
  const input = value();
  if (input.sidecar.upstreamProtocol !== 'openaiChatCompletions') throw new Error('Unexpected fixture protocol');
  input.sidecar.extraFields!.reasoning_details = strings.map(signature => ({ signature }));
  const carrier = await codec.encapsulate(input);
  expect(await codec.unencapsulate(carrier)).toEqual(input);
  const encoded = decode(decodeForgivingBase64(carrier).subarray(32)) as { sidecar: { extraFields: { reasoning_details: Array<{ signature: unknown }> } } };
  for (const [index, signature] of strings.entries()) {
    expect(encoded.sidecar.extraFields.reasoning_details[index].signature instanceof Tag).toBe(signature.length >= 22);
  }
});

test('carrier authentication binds replay to the API key secret and rejects mutations', async () => {
  const carrier = await codec.encapsulate(value());
  const other = createOpenAIChatCompletionsPrivateCodec({ serverSecret: 'second-key' });
  expect(await other.unencapsulate(carrier)).toBeUndefined();
  const changed = decodeForgivingBase64(carrier);
  changed[changed.length - 1] ^= 1;
  expect(await codec.unencapsulate(encodeBase64(changed))).toBeUndefined();
  expect(await codec.unencapsulate('foreign:opaque')).toBeUndefined();
  expect(await codec.unencapsulate({ data: carrier })).toBeUndefined();
});

test('sidecar-only carriers do not invent readable reasoning text', async () => {
  const input = value();
  delete input.reasoningText;
  const carrier = await codec.encapsulate(input);
  expect(await codec.unencapsulate(carrier)).toEqual(input);
  expect(decode(decodeForgivingBase64(carrier).subarray(32))).not.toHaveProperty('reasoningText');
});

test('assistant codec preserves JSON string code units in extension keys and values', async () => {
  const strings = ['"\\ud800"', '"\\udc00"', '"x\\ud800"', '"\\udc00x"', '"\\ud83d\\ude00"'].map(text => JSON.parse(text) as string);
  const input: OpenAIChatCompletionsAssistantMessagePrivate = {
    sidecar: {
      upstreamProtocol: 'openaiChatCompletions',
      extraFields: Object.fromEntries(strings.map((text, index) => [text + index, {
        text,
        longer: [64, 65, 512, 513].map(length => text + 'x'.repeat(length)),
      }])),
    },
  };
  const restored = await codec.unencapsulate(await codec.encapsulate(input));
  expect(JSON.stringify(restored)).toBe(JSON.stringify(input));
});

test('thin ranges and the binary referenced-text digest survive authenticated CBOR round-trip', async () => {
  const input: OpenAIChatCompletionsAssistantMessagePrivate = {
    sidecar: {
      upstreamProtocol: 'openaiResponses',
      thinItems: [{ type: 'reasoning', id: 'rs', __summary: [[[0, 2], [4, 6]]], encrypted_content: 'cipher' }, { type: 'web_search_call', id: 'ws', status: 'completed', action: { type: 'search', query: 'docs' } }],
      referencedTextHash: Uint8Array.from({ length: 16 }, (_, index) => index * 17),
    },
  };
  expect(await codec.unencapsulate(await codec.encapsulate(input))).toEqual(input);
});
