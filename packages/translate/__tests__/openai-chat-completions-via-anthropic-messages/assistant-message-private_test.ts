import { expect, test } from 'vitest';

import { createAnthropicMessagesToOpenAIChatCompletionsStreamState, translateAnthropicMessagesEventToOpenAIChatCompletionsChunks, translateToSourceEvents } from '../../src/openai-chat-completions-via-anthropic-messages/events.ts';
import { translateOpenAIChatCompletionsViaAnthropicMessages } from '../../src/openai-chat-completions-via-anthropic-messages/translate.ts';
import { privateContext, referencedTextHash } from '../test-utils/assistant-message-private.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, collectOpenAIChatCompletionsProtocolEventsToResult, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

const thinking = (index: number): AnthropicMessagesStreamEventEx => ({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } } as AnthropicMessagesStreamEventEx);
const text = (index: number, thinking: string): AnthropicMessagesStreamEventEx => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
const signature = (index: number, signature: string): AnthropicMessagesStreamEventEx => ({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
const collect = async (events: AnthropicMessagesStreamEventEx[]) => {
  const frames = [];
  for await (const frame of translateToSourceEvents((async function* () { for (const event of events) yield eventFrame(event); })())) frames.push(frame);
  const message = (await collectOpenAIChatCompletionsProtocolEventsToResult((async function* () { yield* frames; })())).choices[0].message;
  return { message, frames };
};

test('thin thinking blocks retain signed, unsigned, empty, and redacted metadata without duplicating readable text', async () => {
  const { message, frames } = await collect([thinking(0), text(0, 'A'), text(0, 'B'), signature(0, 's'), signature(0, '1'), { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'R' } }, thinking(2), text(2, 'C'), thinking(3), { type: 'message_stop' }]);
  expect(message[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({
    reasoningText: 'ABC', sidecar: {
      upstreamProtocol: 'anthropicMessages', referencedTextHash: referencedTextHash('ABC'),
      thinBlocks: [{ type: 'thinking', __thinking: [[0, 2]], signature: 's1' }, { type: 'redacted_thinking', data: 'R' }, { type: 'thinking', __thinking: [[2, 3]] }, { type: 'thinking', __thinking: [] }],
    },
  });
  const sidecars = frames.filter(frame => frame.type === 'event' && (frame.event.choices[0]?.delta as OpenAIChatCompletionsAssistantDelta | undefined)?.[OpenAIChatCompletionsAssistantMessagePrivate]?.sidecar !== undefined);
  expect(sidecars).toHaveLength(1);
  expect(frames.indexOf(sidecars[0])).toBe(frames.length - 2);
  expect(JSON.stringify(message)).not.toContain('signature');
});

test('parallel thinking and client tools retain their native owners and Chat tool indices', () => {
  const state = createAnthropicMessagesToOpenAIChatCompletionsStreamState();
  for (const event of [thinking(0), text(0, 'A'), thinking(2), text(2, 'B'), signature(2, 's2'), signature(0, 's0')]) translateAnthropicMessagesEventToOpenAIChatCompletionsChunks(event, state);
  for (const index of [4, 5]) translateAnthropicMessagesEventToOpenAIChatCompletionsChunks({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `t${index}`, name: 'f', input: {} } }, state);
  const chunks = translateAnthropicMessagesEventToOpenAIChatCompletionsChunks({ type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{}' } }, state);
  expect(chunks !== 'DONE' && chunks[0].choices[0].delta.tool_calls?.[0].index).toBe(0);
});

test('hash mismatch discards the entire native thin block layout', async () => {
  const events: AnthropicMessagesStreamEventEx[] = [thinking(0), text(0, 'A'), signature(0, 'signed'),
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: [] } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: [] } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'aa' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'bb' } }, text(0, 'B'),
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'cc' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'dd' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'client', name: 'original', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } },
    { type: 'content_block_start', index: 4, content_block: { type: 'server_tool_use', id: 'server', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"query":"docs"}' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'content_block_start', index: 5, content_block: { type: 'redacted_thinking', data: 'opaque' } }, { type: 'message_stop' }];
  const { message } = await collect(events);
  expect(message.content).toBe('aabbccdd');
  const context = privateContext();
  const data = await context.codec.encapsulate(message[OpenAIChatCompletionsAssistantMessagePrivate]!);
  const replay = JSON.parse(JSON.stringify({ ...message, reasoning: 'AB', reasoning_details: [{ data }], tool_calls: [{ id: 'client', type: 'function', function: { name: 'mangled', arguments: '{"q":1}' } }] })) as OpenAIChatCompletionsAssistantMessageEx;
  for (const mutation of [{ content: 'aabbccdd extra' }, { reasoning: undefined }, { tool_calls: [] }]) {
    const fallback = await translateOpenAIChatCompletionsViaAnthropicMessages({ model: 'm', messages: [{ ...replay, ...mutation }] }, { model: 'm', privateContext: context, loadRemoteImage: async () => { throw new Error('Unexpected image'); } });
    const blocks = fallback.target.messages[0].content;
    expect(JSON.stringify(blocks)).not.toContain('opaque');
    expect(JSON.stringify(blocks)).not.toContain('web_search');
  }
});

test('owned state from a different protocol is dropped', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ sidecar: { upstreamProtocol: 'openaiResponses', thinItems: [{ type: 'reasoning', id: 'r', __summary: [], encrypted_content: 'cipher' }], referencedTextHash: referencedTextHash() } });
  const trip = await translateOpenAIChatCompletionsViaAnthropicMessages({ model: 'm', messages: [{ role: 'assistant', content: 'answer', reasoning_details: [{ data }] } as OpenAIChatCompletionsAssistantMessageEx] }, { model: 'm', privateContext: context, loadRemoteImage: async () => { throw new Error('Unexpected image'); } });
  expect(trip.target.messages[0].content).toMatchObject([{ type: 'text', text: 'answer' }]);
});

test('empty emitted text survives aggregation without mutating citation events', async () => {
  const citation = { type: 'char_location' as const, cited_text: 'quote', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 5, file_id: null };
  const start: AnthropicMessagesStreamEventEx = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } };
  const { message } = await collect([start, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation } }, { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } }, { type: 'message_stop' }]);
  expect(start.content_block.type === 'text' && start.content_block.citations).toEqual([]);
  expect(message.content).toBe('');
});
