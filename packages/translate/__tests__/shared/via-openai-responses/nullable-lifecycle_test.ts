import { describe, expect, it } from 'vitest';

import { translateToSourceEvents as toMessages } from '../../../src/anthropic-messages-via-openai-responses/events.ts';
import { translateToSourceEvents as toGemini } from '../../../src/gemini-generate-content-via-openai-responses/events.ts';
import { translateToSourceEvents as toChat } from '../../../src/openai-chat-completions-via-openai-responses/events.ts';
import { materializeNullableResponsesLifecycle } from '../../../src/shared/via-openai-responses/nullable-lifecycle.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const frames = async function* (events: OpenAIResponsesStreamEventEx[]) { for (const event of events) yield eventFrame(event); };
const collect = async (output: AsyncIterable<ProtocolFrame<unknown>>): Promise<unknown[]> => {
  const events: unknown[] = [];
  for await (const frame of output) if (frame.type === 'event') events.push(frame.event);
  return events;
};
const item = { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{"q":"hello"}', status: 'completed' } as const;
const response = (output: OpenAIResponsesOutputItemEx[], status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({ id: 'resp', object: 'response', model: 'model', status, output, error: null, incomplete_details: null });

const adapters = [
  {
    name: 'Chat Completions', translate: toChat, assertCall: (events: unknown[]) => {
      const calls = (events as Array<{ choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> }>).flatMap(event => event.choices?.flatMap(choice => choice.delta?.tool_calls ?? []) ?? []);
      expect(calls.find(call => call.function?.name === 'lookup')?.id).toBe('call_lookup');
      expect(calls.map(call => call.function?.arguments ?? '').join('')).toBe(item.arguments);
    },
  },
  {
    name: 'Messages', translate: toMessages, assertCall: (events: unknown[]) => {
      const blocks = events as Array<{ type: string; content_block?: { id?: string; name?: string }; delta?: { partial_json?: string } }>;
      expect(blocks.find(block => block.content_block?.name === 'lookup')?.content_block?.id).toBe('call_lookup');
      expect(blocks.map(block => block.delta?.partial_json ?? '').join('')).toBe(item.arguments);
    },
  },
  {
    name: 'Gemini', translate: toGemini, assertCall: (events: unknown[]) => {
      const calls = (events as Array<{ candidates?: Array<{ content?: { parts?: Array<{ functionCall?: unknown }> } }> }>).flatMap(event => event.candidates?.flatMap(candidate => candidate.content?.parts?.flatMap(part => part.functionCall === undefined ? [] : [part.functionCall]) ?? []) ?? []);
      expect(calls).toEqual([{ id: 'call_lookup', name: 'lookup', args: { q: 'hello' } }]);
    },
  },
];

describe.each(adapters)('$name nullable Responses translation', adapter => {
  it.each([
    { evidence: 'materialized', child: false },
    { evidence: 'materialized', child: true },
    { evidence: 'terminal', child: false },
    { evidence: 'terminal', child: true },
  ])('recovers message text with $evidence evidence and child=$child', async ({ evidence, child }) => {
    const message: OpenAIResponsesOutputItemEx = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] };
    const events: OpenAIResponsesStreamEventEx[] = [
      { type: 'response.created', response: response([], 'in_progress') },
      { type: 'response.output_item.added', output_index: 0, item: null },
      ...(child ? [{ type: 'response.output_text.delta' as const, item_id: 'msg', output_index: 0, content_index: 0, delta: 'hello' }] : []),
      { type: 'response.output_item.done', output_index: 0, item: evidence === 'materialized' ? message : null },
      { type: 'response.completed', response: response([message], 'completed') },
    ];
    const translated = await collect(adapter.translate(frames(events))) as Array<{
      choices?: Array<{ delta?: { content?: string } }>;
      delta?: { text?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>;
    const text = translated.flatMap(event => [
      ...(event.choices?.map(choice => choice.delta?.content ?? '') ?? []),
      event.delta?.text ?? '',
      ...(event.candidates?.flatMap(candidate => candidate.content?.parts?.map(part => part.text ?? '') ?? []) ?? []),
    ]).join('');
    expect(text).toBe('hello');
  });

  it.each(['materialized', 'terminal'] as const)('recovers identity and arguments from %s final evidence', async evidence => {
    const events: OpenAIResponsesStreamEventEx[] = [
      { type: 'response.created', response: response([], 'in_progress') },
      { type: 'response.output_item.added', output_index: 0, item: null },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: '{"q":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: '"hello"}' },
      { type: 'response.output_item.done', output_index: 0, item: evidence === 'materialized' ? item : null },
      { type: 'response.completed', response: response([item], 'completed') },
    ];
    adapter.assertCall(await collect(adapter.translate(frames(events))));
    expect(events[1]).toMatchObject({ item: null });
  });

  it.each(['materialized', 'terminal'] as const)('recovers complete arguments from %s evidence without argument children', async evidence => {
    adapter.assertCall(await collect(adapter.translate(frames([
      { type: 'response.created', response: response([], 'in_progress') },
      { type: 'response.output_item.added', output_index: 0, item: null },
      { type: 'response.output_item.done', output_index: 0, item: evidence === 'materialized' ? item : null },
      { type: 'response.completed', response: response([item], 'completed') },
    ]))));
  });
});

it('keeps normal materialized opening frames streaming immediately', async () => {
  const opener = eventFrame({ type: 'response.output_item.added' as const, output_index: 0, item: { ...item, arguments: '' } });
  const error = new Error('upstream failed');
  const source = (async function* () { yield opener; throw error; })();
  const stream = materializeNullableResponsesLifecycle(source);
  expect((await stream.next()).value).toBe(opener);
  await expect(stream.next()).rejects.toBe(error);
});

it('preserves original transport errors while identity is undecided', async () => {
  const error = new Error('upstream failed');
  const source = (async function* () {
    yield eventFrame({ type: 'response.output_item.added' as const, output_index: 0, item: null });
    yield eventFrame({ type: 'response.function_call_arguments.delta' as const, output_index: 0, item_id: item.id, delta: '{' });
    throw error;
  })();
  await expect(collect(materializeNullableResponsesLifecycle(source))).rejects.toBe(error);
});

it('preserves the upstream protocol error without fabricating callable identity', async () => {
  const error: OpenAIResponsesStreamEventEx = { type: 'error', message: 'upstream failed', code: 'upstream_failure' };
  expect(await collect(materializeNullableResponsesLifecycle(frames([
    { type: 'response.output_item.added', output_index: 0, item: null },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: '{' },
    error,
  ])))).toEqual([error]);
});

it('keeps interleaved item indexes and child order while resolving a nullable opener', async () => {
  const later = { ...item, id: 'fc_later', call_id: 'call_later', name: 'later', arguments: '{}' };
  const output = await collect(materializeNullableResponsesLifecycle(frames([
    { type: 'response.output_item.added', output_index: 0, item: null },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
    { type: 'response.output_item.added', output_index: 1, item: { ...later, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: later.id, delta: '{}' },
    { type: 'response.output_item.done', output_index: 1, item: later },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: response([item, later], 'completed') },
  ])));
  expect(output).toEqual([
    expect.objectContaining({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }),
    expect.objectContaining({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }),
    expect.objectContaining({ type: 'response.output_item.added', output_index: 1, item: { ...later, arguments: '' } }),
    expect.objectContaining({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' }),
    expect.objectContaining({ type: 'response.output_item.done', output_index: 1, item: later }),
    expect.objectContaining({ type: 'response.function_call_arguments.done', output_index: 0, arguments: item.arguments }),
    expect.objectContaining({ type: 'response.output_item.done', output_index: 0, item }),
    expect.objectContaining({ type: 'response.completed' }),
  ]);
});

it('requires finalized callable evidence after an otherwise successful terminal', async () => {
  await expect(collect(materializeNullableResponsesLifecycle(frames([
    { type: 'response.output_item.added', output_index: 0, item: null },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: '{' },
    { type: 'response.completed', response: response([], 'completed') },
  ])))).rejects.toThrow('no finalized item evidence');
});

it('recovers a custom call without duplicating its streamed input', async () => {
  const custom = { type: 'custom_tool_call', id: 'ct_shell', call_id: 'call_shell', name: 'shell', input: 'echo hello' } as const;
  const output = await collect(toChat(frames([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: null },
    { type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: custom.id, delta: custom.input },
    { type: 'response.output_item.done', output_index: 0, item: custom },
    { type: 'response.completed', response: response([custom], 'completed') },
  ])));
  const calls = (output as Array<{ choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; custom?: { name?: string; input?: string } }> } }> }>).flatMap(event => event.choices?.flatMap(choice => choice.delta?.tool_calls ?? []) ?? []);
  expect(calls.find(call => call.custom?.name === 'shell')?.id).toBe('call_shell');
  expect(calls.map(call => call.custom?.input ?? '').join('')).toBe(custom.input);
});
