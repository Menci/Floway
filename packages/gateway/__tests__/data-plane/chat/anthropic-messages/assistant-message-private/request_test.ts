import { expect, test } from 'vitest';

import { discardAnthropicMessagesChatReplay } from '../../../../../src/data-plane/chat/anthropic-messages/assistant-message-private/request.ts';
import { createOpenAIChatCompletionsPrivateCodec } from '../../../../../src/data-plane/chat/shared/assistant-message-private/codec.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const codec = createOpenAIChatCompletionsPrivateCodec({ serverSecret: '22'.repeat(32) });

test('consumes owned Chat carriers and display thinking while retaining native opaque blocks and ordinary content', async () => {
  const data = await codec.encapsulate({ reasoningText: 'owned', sidecar: { upstreamProtocol: 'openaiChatCompletions' } });
  const payload: AnthropicMessagesPayload = {
    model: 'm', max_tokens: 1, messages: [{
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'display', signature: '' },
        { type: 'text', text: 'answer' },
        { type: 'thinking', thinking: 'native', signature: 'native-signature' },
        { type: 'redacted_thinking', data: 'native-redacted' },
        { type: 'redacted_thinking', data },
      ],
    }, { role: 'user', content: 'next' }],
  };
  const normalized = await discardAnthropicMessagesChatReplay(payload, codec);
  expect(normalized.messages[0]).toEqual({
    role: 'assistant', content: [
      { type: 'text', text: 'answer' },
      { type: 'thinking', thinking: 'native', signature: 'native-signature' },
      { type: 'redacted_thinking', data: 'native-redacted' },
    ],
  });
  expect(payload.messages[0].content).toHaveLength(5);
  expect(normalized.messages[1]).toBe(payload.messages[1]);
});

test('removes an assistant containing only owned replay data and preserves foreign history identity', async () => {
  const data = await codec.encapsulate({ sidecar: { upstreamProtocol: 'openaiChatCompletions' } });
  const payload: AnthropicMessagesPayload = { model: 'm', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data }] }, { role: 'user', content: 'next' }] };
  expect((await discardAnthropicMessagesChatReplay(payload, codec)).messages).toEqual([payload.messages[1]]);
  const foreign: AnthropicMessagesPayload = { model: 'm', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'native', signature: '' }] }] };
  expect(await discardAnthropicMessagesChatReplay(foreign, codec)).toBe(foreign);
});
