import { expect, test } from 'vitest';

import { translateToSourceEvents } from '../../src/openai-chat-completions-via-anthropic-messages/events.ts';
import { buildTargetRequest } from '../../src/openai-chat-completions-via-anthropic-messages/request.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import { decodeChatCompletionsReasoningData, encodeChatCompletionsReasoningData, FlowayOpenAIChatCompletionsReasoning, reassembleOpenAIChatCompletionsEvents } from '@floway-dev/protocols/openai-chat-completions';

const start: AnthropicMessagesStreamEvent = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };

test('Messages content retains thinking/text/tool interleaving, signatures and metadata through Chat history', async () => {
  const events: AnthropicMessagesStreamEvent[] = [start,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'First' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-first' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '中文回答' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'redacted' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: 'Second' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature: 'sig-' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature: 'second' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_start', index: 4, content_block: Object.assign({ type: 'tool_use' as const, id: 'call_1', name: 'lookup', input: {} }, { future: { kept: true } }) },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'content_block_start', index: 5, content_block: { type: 'text', text: 'After tool' } },
    { type: 'content_block_stop', index: 5 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' }];
  const frames = async function* () { for (const event of events) yield eventFrame(event); };
  const chunks = async function* () { for await (const frame of translateToSourceEvents(frames())) if (frame.type === 'event') yield frame.event; };
  const result = await reassembleOpenAIChatCompletionsEvents(chunks());
  const message = result.choices[0].message;
  const expected = [
    { type: 'thinking', thinking: 'First', signature: 'sig-first' },
    { type: 'text', text: '中文回答' },
    { type: 'redacted_thinking', data: 'redacted' },
    { type: 'thinking', thinking: 'Second', signature: 'sig-second' },
    { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' }, future: { kept: true } },
    { type: 'text', text: 'After tool' },
  ];
  const opaque = message[FlowayOpenAIChatCompletionsReasoning]!.reasoning_opaque;
  expect(message[FlowayOpenAIChatCompletionsReasoning]!.reasoning).toBe('FirstSecond');
  expect(JSON.parse(Buffer.from(opaque, 'base64').toString('utf8'))).toEqual({ type: 'anthropic-messages-content-blocks', content: expected });
  const request = await buildTargetRequest({ model: 'm', messages: [message] });
  expect(request.messages[0].content).toEqual([...expected.slice(0, -1), { ...expected.at(-1), cache_control: { type: 'ephemeral' } }]);
  expect(message.content).toBe('中文回答After tool');
});

test('Messages internal content standard rejects malformed block arrays before replay', async () => {
  const message = { role: 'assistant' as const, content: null, [FlowayOpenAIChatCompletionsReasoning]: { reasoning: '', reasoning_opaque: encodeChatCompletionsReasoningData('anthropic-messages-content-blocks', [null]) } };
  await expect(buildTargetRequest({ model: 'm', messages: [message] })).rejects.toThrow('Malformed Anthropic Messages content blocks');
  expect(decodeChatCompletionsReasoningData('native-opaque')).toBeUndefined();
});
