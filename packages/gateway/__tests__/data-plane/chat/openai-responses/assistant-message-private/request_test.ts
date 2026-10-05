import { expect, test } from 'vitest';

import { discardOpenAIResponsesChatReplay } from '../../../../../src/data-plane/chat/openai-responses/assistant-message-private/request.ts';
import { createOpenAIChatCompletionsPrivateCodec } from '../../../../../src/data-plane/chat/shared/assistant-message-private/codec.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const codec = createOpenAIChatCompletionsPrivateCodec({ serverSecret: '22'.repeat(32) });

test('consumes owned Chat interval carriers and readable projections while preserving text, tools, and foreign opaque reasoning', async () => {
  const data = await codec.encapsulate({ sidecar: { upstreamProtocol: 'openaiChatCompletions', extraFields: { reasoning_opaque: 'native-chat-state' } } });
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'm', input: [
      { type: 'reasoning', id: 'unowned', summary: [], content: [{ type: 'reasoning_text', text: 'foreign-readable' }] },
      { type: 'message', role: 'user', content: 'next' },
      { type: 'reasoning', id: 'owned-readable', summary: [], content: [{ type: 'reasoning_text', text: 'owned' }] },
      { type: 'message', role: 'assistant', content: 'answer' },
      { type: 'reasoning', id: 'foreign-opaque', summary: [], encrypted_content: 'native-responses-state' },
      { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
      { type: 'reasoning', id: 'boundary', summary: [], encrypted_content: data },
      { type: 'function_call_output', call_id: 'c', output: 'ok' },
    ],
  };
  const normalized = await discardOpenAIResponsesChatReplay(payload, codec);
  expect(normalized.input).toEqual([payload.input[0], payload.input[1], payload.input[3], payload.input[4], payload.input[5], payload.input[7]]);
  expect(payload.input).toHaveLength(8);
  expect(normalized.input[2]).toBe(payload.input[3]);
});

test('preserves history identity when no owned Chat carrier is present', async () => {
  const payload: CanonicalOpenAIResponsesPayload = { model: 'm', input: [{ type: 'reasoning', id: 'r', summary: [], encrypted_content: 'foreign' }] };
  expect(await discardOpenAIResponsesChatReplay(payload, codec)).toBe(payload);
});
