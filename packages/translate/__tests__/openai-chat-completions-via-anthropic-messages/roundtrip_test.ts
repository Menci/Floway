import { expect, test } from 'vitest';

import { translateToSourceEvents } from '../../src/openai-chat-completions-via-anthropic-messages/events.ts';
import { buildTargetRequest } from '../../src/openai-chat-completions-via-anthropic-messages/request.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import { decodeChatCompletionsReasoningData, encodeChatCompletionsReasoningData, FlowayOpenAIChatCompletionsReasoning, reassembleOpenAIChatCompletionsEvents } from '@floway-dev/protocols/openai-chat-completions';

const start: AnthropicMessagesStreamEvent = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };

test('Messages reasoning uses LiteLLM blocks while editable Chat text and tools are rebuilt separately', async () => {
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
    { type: 'redacted_thinking', data: 'redacted' },
    { type: 'thinking', thinking: 'Second', signature: 'sig-second' },
  ];
  const opaque = message[FlowayOpenAIChatCompletionsReasoning]!.reasoning_opaque;
  expect(message[FlowayOpenAIChatCompletionsReasoning]!.reasoning).toBe('FirstSecond');
  expect(JSON.parse(Buffer.from(opaque, 'base64').toString('utf8'))).toEqual({ type: 'litellm-thinking-blocks', thinking_blocks: expected });
  const edited = { ...message, content: 'Edited answer', tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'edited_lookup', arguments: '{"q":"edited"}' } }] };
  const request = await buildTargetRequest({ model: 'm', messages: [edited] });
  expect(request.messages[0].content).toEqual([...expected, { type: 'text', text: 'Edited answer' }, { type: 'tool_use', id: 'call_1', name: 'edited_lookup', input: { q: 'edited' }, cache_control: { type: 'ephemeral' } }]);
  expect(message.content).toBe('中文回答After tool');
});

test('Messages rejects malformed matching LiteLLM block arrays before replay', async () => {
  const message = { role: 'assistant' as const, content: null, [FlowayOpenAIChatCompletionsReasoning]: { reasoning: '', reasoning_opaque: encodeChatCompletionsReasoningData('litellm-thinking-blocks', [null]) } };
  await expect(buildTargetRequest({ model: 'm', messages: [message] })).rejects.toThrow('Malformed Chat Completions reasoning thinking_blocks');
  expect(decodeChatCompletionsReasoningData('native-opaque')).toBeUndefined();
});

test('Messages server tools replay with LiteLLM positional thinking/tool pairing', async () => {
  const searchResult = (index: number, id: string): AnthropicMessagesStreamEvent => ({ type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: id, content: [] } });
  const events: AnthropicMessagesStreamEvent[] = [start,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'First' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'first' } } },
    { type: 'content_block_stop', index: 1 },
    searchResult(2, 'srvtoolu_1'),
    { type: 'content_block_start', index: 3, content_block: { type: 'thinking', thinking: 'Second' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature: 'sig-2' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_start', index: 4, content_block: { type: 'text', text: 'Answer' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'content_block_start', index: 5, content_block: { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'second' } } },
    { type: 'content_block_stop', index: 5 },
    searchResult(6, 'srvtoolu_2'),
    { type: 'content_block_start', index: 7, content_block: { type: 'tool_use', id: 'call_empty', name: 'done', input: {} } },
    { type: 'content_block_stop', index: 7 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' }];
  const frames = async function* () { for (const event of events) yield eventFrame(event); };
  const chunks = async function* () { for await (const frame of translateToSourceEvents(frames())) if (frame.type === 'event') yield frame.event; };
  const result = await reassembleOpenAIChatCompletionsEvents(chunks());
  const message = result.choices[0].message;
  expect(message.tool_calls?.map(tool => tool.id)).toEqual(['srvtoolu_1', 'srvtoolu_2', 'call_empty']);
  expect(message.tool_calls?.at(-1)?.function.arguments).toBe('{}');
  expect(message.provider_specific_fields?.web_search_results).toHaveLength(2);
  const request = await buildTargetRequest({ model: 'm', messages: [message] });
  expect(request.messages[0].content).toEqual([
    { type: 'thinking', thinking: 'First', signature: 'sig-1' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'first' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
    { type: 'thinking', thinking: 'Second', signature: 'sig-2' },
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'second' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: [] },
    { type: 'text', text: 'Answer' },
    { type: 'tool_use', id: 'call_empty', name: 'done', input: {}, cache_control: { type: 'ephemeral' } },
  ]);
});
