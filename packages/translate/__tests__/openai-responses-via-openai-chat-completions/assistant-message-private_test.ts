import { expect, test } from 'vitest';

import { createOpenAIChatCompletionsToOpenAIResponsesStreamState, translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents, translateToSourceEvents } from '../../src/openai-responses-via-openai-chat-completions/events.ts';
import { translateOpenAIResponsesViaOpenAIChatCompletions } from '../../src/openai-responses-via-openai-chat-completions/translate.ts';
import { privateContext } from '../test-utils/assistant-message-private.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const sidecar = { upstreamProtocol: 'openaiChatCompletions' as const, textFieldOriginalName: 'reasoning_content' as const, extraFields: { reasoning_opaque: 'native' }, toolCallExtraFields: {} };
const chunk = (delta: OpenAIChatCompletionsAssistantDelta): OpenAIChatCompletionsStreamEvent => ({ id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: null }] });
const thought = (text?: string): OpenAIChatCompletionsAssistantDelta => ({ [OpenAIChatCompletionsAssistantMessagePrivate]: text !== undefined ? { reasoningText: text } : { sidecar } });

test('reasoning/text/reasoning is live and each interruption closes the previous item', () => {
  const state = createOpenAIChatCompletionsToOpenAIResponsesStreamState();
  const first = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk(thought('A')), state);
  expect(first.at(-1)).toMatchObject({ type: 'response.reasoning_text.delta', delta: 'A', output_index: 0 });
  expect(first.some(event => event.type === 'response.reasoning_summary_text.delta')).toBe(false);
  const second = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk({ content: 'answer' }), state);
  expect(second[2]).toMatchObject({ type: 'response.output_item.done', output_index: 0, item: { content: [{ type: 'reasoning_text', text: 'A' }] } });
  expect(second.at(-1)).toMatchObject({ type: 'response.output_text.delta', output_index: 1, delta: 'answer' });
  const third = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk(thought('B')), state);
  expect(third.at(-1)).toMatchObject({ type: 'response.reasoning_text.delta', output_index: 2, delta: 'B' });
});

test('incomplete tools remain active across text, close at their JSON boundary, and late arguments are warned and ignored', () => {
  const state = createOpenAIChatCompletionsToOpenAIResponsesStreamState();
  const first = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{' } }] }), state);
  expect(first.at(-1)).toMatchObject({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' });
  const second = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk({ content: 'live' }), state);
  expect(second.some(event => event.type === 'response.output_item.done')).toBe(false);
  const third = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }), state);
  expect(third.at(-1)).toMatchObject({ type: 'response.output_item.done', output_index: 0 });
});

test('stream end emits one encrypted-only carrier with the final sidecar and keeps terminal output in creation order', async () => {
  const context = privateContext();
  const events: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of translateToSourceEvents((async function* () { yield eventFrame(chunk(thought('A'))); yield eventFrame(chunk({ content: 'answer' })); yield eventFrame(chunk(thought('B'))); yield eventFrame(chunk(thought())); yield doneFrame(); })(), new Set(), context)) {
    if (frame.type === 'event') events.push(frame.event);
  }
  const terminal = events.at(-1);
  expect(terminal?.type).toBe('response.completed');
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal');
  expect(terminal.response.output.map(item => item.type)).toEqual(['reasoning', 'message', 'reasoning', 'reasoning']);
  const carrier = terminal.response.output.at(-1);
  if (carrier?.type !== 'reasoning') throw new Error('Expected carrier');
  expect(carrier.content).toBeUndefined();
  expect(await context.codec.unencapsulate(carrier.encrypted_content)).toEqual({ sidecar });
  expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
});

test('every owned carrier ends one assistant interval and attaches only that interval reasoning content', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ sidecar });
  const second = await context.codec.encapsulate({ sidecar: { ...sidecar, extraFields: { reasoning_opaque: 'second' } } });
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'reasoning', id: 'r0', summary: [], content: [{ type: 'reasoning_text', text: 'A' }] },
    { type: 'message', role: 'assistant', content: 'answer' },
    { type: 'reasoning', id: 'r1', summary: [], content: [{ type: 'reasoning_text', text: 'B' }], encrypted_content: 'foreign' },
    { type: 'reasoning', id: 'r2', summary: [], encrypted_content: data },
    { type: 'reasoning', id: 'r3', summary: [], encrypted_content: second },
    { type: 'message', role: 'user', content: 'next' },
  ];
  const trip = await translateOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', input }, { model: 'm', privateContext: context });
  expect((trip.target.messages[0] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: 'AB', sidecar });
  expect(trip.target.messages).toHaveLength(3);
  expect((trip.target.messages[1] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: undefined, sidecar: { ...sidecar, extraFields: { reasoning_opaque: 'second' } } });
  expect(JSON.stringify(trip.target)).not.toContain('encrypted_content');
  expect(input[3]).toMatchObject({ encrypted_content: data });
});

test('sidecar-only history remains replayable when the client omits all readable reasoning content', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ sidecar });
  const trip = await translateOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', input: [{ type: 'reasoning', id: 'r', summary: [], encrypted_content: data }] }, { model: 'm', privateContext: context });
  expect((trip.target.messages[0] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: undefined, sidecar });
});

test('a plain Chat assistant still ends with an authenticated empty boundary marker', async () => {
  const context = privateContext();
  const events: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of translateToSourceEvents((async function* () { yield eventFrame(chunk({ content: 'answer' })); yield doneFrame(); })(), new Set(), context)) {
    if (frame.type === 'event') events.push(frame.event);
  }
  const terminal = events.at(-1);
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal');
  expect(terminal.response.output.map(item => item.type)).toEqual(['message', 'reasoning']);
  const marker = terminal.response.output[1];
  if (marker.type !== 'reasoning') throw new Error('Expected boundary marker');
  expect(marker.content).toBeUndefined();
  expect(await context.codec.unencapsulate(marker.encrypted_content)).toEqual({ sidecar: { upstreamProtocol: 'openaiChatCompletions' } });
});

test('owned markers preserve adjacent assistant boundaries and foreign intervals discard their reasoning', async () => {
  const context = privateContext();
  const data = await context.codec.encapsulate({ sidecar });
  const trip = await translateOpenAIResponsesViaOpenAIChatCompletions({
    model: 'm', input: [
      { type: 'reasoning', id: 'r0', summary: [], content: [{ type: 'reasoning_text', text: 'owned' }] },
      { type: 'message', role: 'assistant', content: 'first' },
      { type: 'reasoning', id: 'end0', summary: [], encrypted_content: data },
      { type: 'reasoning', id: 'r1', summary: [], content: [{ type: 'reasoning_text', text: 'foreign' }] },
      { type: 'message', role: 'assistant', content: 'second' },
      { type: 'message', role: 'user', content: 'next' },
      { type: 'reasoning', id: 'r2', summary: [], content: [{ type: 'reasoning_text', text: 'owned-again' }] },
      { type: 'function_call', call_id: 'call', name: 'f', arguments: '{}' },
      { type: 'reasoning', id: 'end2', summary: [], encrypted_content: data },
      { type: 'function_call_output', call_id: 'call', output: 'ok' },
    ],
  }, { model: 'm', privateContext: context });
  expect(trip.target.messages).toMatchObject([
    { role: 'assistant', content: 'first', [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: 'owned', sidecar } },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'next' },
    { role: 'assistant', tool_calls: [{ id: 'call' }], [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: 'owned-again', sidecar } },
    { role: 'tool', tool_call_id: 'call', content: 'ok' },
  ]);
  expect((trip.target.messages[1] as import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsAssistantMessage)[OpenAIChatCompletionsAssistantMessagePrivate]).toBeUndefined();
});

test('an empty upstream cannot mint a Responses carrier without a response lifecycle', async () => {
  const collect = async () => {
    for await (const _frame of translateToSourceEvents((async function* () { yield doneFrame(); })(), new Set(), privateContext())) { }
  };
  await expect(collect()).rejects.toThrow('Upstream Chat Completions stream contained no completion chunks.');
});
