import { expect, test } from 'vitest';

import { createOpenAIResponsesToOpenAIChatCompletionsStreamState, translateOpenAIResponsesEventToOpenAIChatCompletionsChunks } from '../../src/openai-chat-completions-via-openai-responses/events.ts';
import { translateOpenAIChatCompletionsViaOpenAIResponses } from '../../src/openai-chat-completions-via-openai-responses/translate.ts';
import { privateContext, referencedTextHash } from '../test-utils/assistant-message-private.ts';
import { OpenAIChatCompletionsAssistantMessagePrivate, reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const item = (id: string, text = '', cipher = ''): OpenAIResponsesOutputReasoning => ({ type: 'reasoning', id, summary: text ? [{ type: 'summary_text', text }] : [], ...(cipher ? { encrypted_content: cipher } : {}) });
const added = (output_index: number, item: OpenAIResponsesOutputItemEx): OpenAIResponsesStreamEventEx => ({ type: 'response.output_item.added', output_index, item });
const done = (output_index: number, item: OpenAIResponsesOutputItemEx): OpenAIResponsesStreamEventEx => ({ type: 'response.output_item.done', output_index, item });
const summary = (output_index: number, delta: string): OpenAIResponsesStreamEventEx => ({ type: 'response.reasoning_summary_text.delta', output_index, item_id: `r${output_index}`, summary_index: 0, delta });
const terminal = (output: OpenAIResponsesOutputItemEx[]): OpenAIResponsesStreamEventEx => ({ type: 'response.completed', response: { id: 'resp', object: 'response', model: 'm', created_at: 1, status: 'completed', error: null, incomplete_details: null, output } });
const collect = async (events: OpenAIResponsesStreamEventEx[]) => {
  const state = createOpenAIResponsesToOpenAIChatCompletionsStreamState();
  const chunks = events.flatMap(event => translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(event, state));
  return { chunks, message: (await reassembleOpenAIChatCompletionsEvents((async function* () { yield* chunks; })())).choices[0].message };
};

test('thin reasoning items preserve native order and ciphertext while live summaries remain outside the sidecar', async () => {
  const { message, chunks } = await collect([added(0, item('r0')), summary(0, 'A'), added(1, item('r1')), summary(1, 'B'), done(1, item('r1', 'B', 'cipher1')), done(0, item('r0', 'A', 'cipher0')), done(2, item('r2', '', 'cipher2')), terminal([item('r0', 'A', 'cipher0'), item('r1', 'B', 'cipher1'), item('r2', '', 'cipher2')])]);
  expect(message[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({
    reasoningText: 'AB', sidecar: {
      upstreamProtocol: 'openaiResponses', referencedTextHash: referencedTextHash('AB'),
      thinItems: [{ type: 'reasoning', id: 'r0', __summary: [[[0, 1]]], encrypted_content: 'cipher0' }, { type: 'reasoning', id: 'r1', __summary: [[[1, 2]]], encrypted_content: 'cipher1' }, { type: 'reasoning', id: 'r2', __summary: [], encrypted_content: 'cipher2' }],
    },
  });
  const sidecars = chunks.filter(chunk => (chunk.choices[0]?.delta as OpenAIChatCompletionsAssistantDelta | undefined)?.[OpenAIChatCompletionsAssistantMessagePrivate]?.sidecar !== undefined);
  expect(sidecars).toHaveLength(1);
  expect(chunks.indexOf(sidecars[0])).toBe(chunks.length - 2);
  expect(JSON.stringify(message)).not.toContain('cipher');
});

test('text is forwarded while earlier reasoning remains open, and done-only summaries are not duplicated', async () => {
  const state = createOpenAIResponsesToOpenAIChatCompletionsStreamState();
  translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(added(0, item('r0')), state);
  const chunks = translateOpenAIResponsesEventToOpenAIChatCompletionsChunks({ type: 'response.output_text.delta', output_index: 1, item_id: 'm', content_index: 0, delta: 'live' }, state);
  expect(chunks[0].choices[0].delta.content).toBe('live');
  const complete = item('rs', 'trace', 'cipher');
  const collected = await collect([done(0, complete), terminal([complete])]);
  expect(collected.message[OpenAIChatCompletionsAssistantMessagePrivate]?.reasoningText).toBe('trace');
});

test('interleaved messages, summary and content parts, tools, and opaque items replay in native index order', async () => {
  const messageItem = (id: string, text: string): OpenAIResponsesOutputItemEx => ({ type: 'message', id, role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text, annotations: [] }] });
  const reasoning: OpenAIResponsesOutputReasoning = { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'AB' }], content: [{ type: 'reasoning_text', text: 'CD' }], encrypted_content: 'opaque' };
  const call: OpenAIResponsesOutputItemEx = { type: 'function_call', id: 'fc', call_id: 'c', name: 'original', arguments: '{"q":1}', status: 'completed' };
  const hosted: OpenAIResponsesOutputItemEx = { type: 'web_search_call', id: 'ws', status: 'completed', action: { type: 'search', query: 'docs' } };
  const custom: OpenAIResponsesOutputItemEx = { type: 'custom_tool_call', id: 'ct', call_id: 'custom', name: 'raw', input: 'line\n😀', status: 'completed' };
  const native = [messageItem('a', 'aacc'), reasoning, call, messageItem('b', 'bbdd'), hosted, custom];
  const delta = (output_index: number, delta: string): OpenAIResponsesStreamEventEx => ({ type: 'response.output_text.delta', output_index, item_id: `${output_index}`, content_index: 0, delta });
  const { message } = await collect([
    added(0, messageItem('a', '')), added(1, item('r')), added(3, messageItem('b', '')),
    delta(0, 'aa'), delta(3, 'bb'), summary(1, 'A'), delta(0, 'cc'),
    { type: 'response.reasoning_text.delta', output_index: 1, item_id: 'r', content_index: 0, delta: 'C' },
    delta(3, 'dd'), summary(1, 'B'), { type: 'response.reasoning_text.delta', output_index: 1, item_id: 'r', content_index: 0, delta: 'D' },
    added(2, { ...call, arguments: '' }), { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc', delta: '{"q":1}' },
    added(5, { ...custom, input: '' }), { type: 'response.custom_tool_call_input.delta', output_index: 5, item_id: 'ct', delta: 'line\n' },
    { type: 'response.custom_tool_call_input.delta', output_index: 5, item_id: 'ct', delta: '😀' },
    { type: 'response.custom_tool_call_input.done', output_index: 5, item_id: 'ct', input: custom.input },
    ...native.map((item, i) => done(i, item)), terminal(native),
  ]);
  expect(message.content).toBe('aabbccdd');
  expect(message[OpenAIChatCompletionsAssistantMessagePrivate]?.reasoningText).toBe('ACBD');
  const privateState = message[OpenAIChatCompletionsAssistantMessagePrivate]!;
  expect(JSON.stringify(privateState.sidecar)).not.toContain('aacc');
  expect(JSON.stringify(privateState.sidecar)).not.toContain('{\\"q\\":1}');
  const context = privateContext();
  const data = await context.codec.encapsulate(privateState);
  const replay = JSON.parse(JSON.stringify({ ...message, reasoning: 'ACBD', reasoning_details: [{ data }] })) as OpenAIChatCompletionsAssistantMessageEx;
  const trip = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', messages: [replay] }, { model: 'm', privateContext: context });
  expect(trip.target.input).toEqual(native);
  expect(message.tool_calls).toHaveLength(1);
  expect(privateState.sidecar.upstreamProtocol === 'openaiResponses' && privateState.sidecar.thinItems.at(-1)).toEqual(custom);
  expect(JSON.stringify(message.tool_calls)).not.toContain('line');
  for (const mutation of [{ content: 'aabbccdd extra' }, { reasoning: undefined }, { tool_calls: [] }]) {
    const fallback = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', messages: [{ ...replay, ...mutation }] }, { model: 'm', privateContext: context });
    expect(JSON.stringify(fallback.target.input)).not.toContain('opaque');
    expect(fallback.target.input.some(item => item.type === 'web_search_call')).toBe(false);
  }
});

test('owned state from a different protocol is dropped', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ sidecar: { upstreamProtocol: 'anthropicMessages', thinBlocks: [{ type: 'redacted_thinking', data: 'native' }], referencedTextHash: referencedTextHash() } });
  const trip = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', messages: [{ role: 'assistant', content: 'answer', reasoning: 'trace', reasoning_details: [{ data }] } as OpenAIChatCompletionsAssistantMessageEx] }, { model: 'm', privateContext: context });
  expect(trip.target.input).toHaveLength(1);
  expect(trip.target.input[0].type).toBe('message');
});

test('initial item and part text is included before later deltas and remains referenced exactly once', async () => {
  const initialMessage: OpenAIResponsesOutputItemEx = { type: 'message', id: 'm', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: 'pre', annotations: [] }] };
  const reasoning = item('r', 'initial');
  const finalMessage: OpenAIResponsesOutputItemEx = { ...initialMessage, status: 'completed', content: [{ type: 'output_text', text: 'prefix', annotations: [] }] };
  const finalReasoning = item('r', 'initial tail');
  const { message } = await collect([added(0, initialMessage), added(1, reasoning), { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'm', part: initialMessage.content[0] }, { type: 'response.reasoning_summary_part.added', output_index: 1, summary_index: 0, item_id: 'r', part: reasoning.summary[0] }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'm', delta: 'fix' }, summary(1, ' tail'), done(0, finalMessage), done(1, finalReasoning), terminal([finalMessage, finalReasoning])]);
  expect(message.content).toBe('prefix');
  expect(message[OpenAIChatCompletionsAssistantMessagePrivate]?.reasoningText).toBe('initial tail');
  const context = privateContext();
  const data = await context.codec.encapsulate(message[OpenAIChatCompletionsAssistantMessagePrivate]!);
  const replay = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', messages: [{ role: 'assistant', content: 'prefix', reasoning: 'initial tail', reasoning_details: [{ data }] } as OpenAIChatCompletionsAssistantMessageEx] }, { model: 'm', privateContext: context });
  expect(replay.target.input).toEqual([finalMessage, finalReasoning]);
});

test('thin items restore interleaved surrogate halves and lone code units through a JSON history round-trip', async () => {
  const textItem = (id: string, text: string): OpenAIResponsesOutputItemEx => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  const native = [textItem('a', '😀'), textItem('b', 'x\ud800')];
  const delta = (output_index: number, delta: string): OpenAIResponsesStreamEventEx => ({ type: 'response.output_text.delta', output_index, content_index: 0, item_id: native[output_index].id!, delta });
  const { message } = await collect([added(0, textItem('a', '')), added(1, textItem('b', '')), delta(0, '\ud83d'), delta(1, 'x'), delta(0, '\ude00'), delta(1, '\ud800'), done(1, native[1]), done(0, native[0]), terminal(native)]);
  expect(message.content).toBe('\ud83dx\ude00\ud800');
  const context = privateContext();
  const data = await context.codec.encapsulate(message[OpenAIChatCompletionsAssistantMessagePrivate]!);
  const replay = JSON.parse(JSON.stringify({ role: 'assistant', content: message.content, reasoning_details: [{ data }] })) as OpenAIChatCompletionsAssistantMessageEx;
  const trip = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', messages: [replay] }, { model: 'm', privateContext: context });
  expect(trip.target.input).toEqual(native);
});
