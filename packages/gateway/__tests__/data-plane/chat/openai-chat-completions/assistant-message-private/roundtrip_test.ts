import { expect, test } from 'vitest';

import { extractOpenAIChatCompletionsPrivate } from '../../../../../src/data-plane/chat/openai-chat-completions/assistant-message-private/extract.ts';
import { decodeOpenAIChatCompletionsPrivateHistory, restoreOpenAIChatCompletionsPrivateHistory } from '../../../../../src/data-plane/chat/openai-chat-completions/assistant-message-private/request.ts';
import { encodeOpenAIChatCompletionsPrivate } from '../../../../../src/data-plane/chat/openai-chat-completions/assistant-message-private/response.ts';
import { openaiChatCompletionsAttempt } from '../../../../../src/data-plane/chat/openai-chat-completions/attempt.ts';
import { createOpenAIChatCompletionsPrivateCodec } from '../../../../../src/data-plane/chat/shared/assistant-message-private/codec.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsAssistantMessageEx, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsPrivateContext, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

const context: OpenAIChatCompletionsPrivateContext = { codec: createOpenAIChatCompletionsPrivateCodec({ serverSecret: 'test' }), preference: { textFieldName: 'reasoning', reasoningEncapsulationFormat: 'openrouter-reasoning_details' } };
const chunk = (delta: OpenAIChatCompletionsAssistantDeltaEx, finish_reason: 'stop' | null = null): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => eventFrame({ id: 'chat', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason }] });
const frames = async function* (values: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) { yield* values; };
const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => { const result: T[] = []; for await (const value of values) result.push(value); return result; };

test('native extraction streams text and emits one EOF sidecar with late tool metadata', async () => {
  const input = [
    chunk({ reasoning_content: '', metadata: { value: 'first' } }),
    chunk({ content: 'visible', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, 'stop'),
    chunk({ reasoning_content: 'later', metadata: { value: 'latest' }, tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'sig' } } }] }),
    doneFrame(),
  ];
  const original = structuredClone(input);
  const output = await collect(extractOpenAIChatCompletionsPrivate(frames(input)));
  const deltas = output.flatMap(frame => frame.type === 'event' ? frame.event.choices.map(choice => choice.delta as OpenAIChatCompletionsAssistantDeltaEx) : []);
  const privateDeltas = deltas.map(delta => delta[OpenAIChatCompletionsAssistantMessagePrivate]).filter(value => value !== undefined);
  expect(privateDeltas).toEqual([
    { reasoningText: '' }, { reasoningText: 'later' },
    { sidecar: { upstreamProtocol: 'openaiChatCompletions', textFieldOriginalName: 'reasoning_content', extraFields: { metadata: { value: 'latest' } }, toolCallExtraFields: { call: { extra_content: { google: { thought_signature: 'sig' } } } } } },
  ]);
  expect(deltas[2]).not.toHaveProperty('tool_calls');
  expect(input).toEqual(original);
});

test('native presentation and history restore all assistant/tool extensions without changing prototypes', async () => {
  const extra = JSON.parse('{"__proto__":{"kept":true},"provider_specific_fields":{"mode":"original"}}') as Record<string, unknown>;
  const source = frames([
    chunk({ reasoning_text: 'A', ...extra }), chunk({ content: 'answer', reasoning_text: 'B', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' }, custom_metadata: 42 }] }, 'stop'), doneFrame(),
  ]);
  const encoded = encodeOpenAIChatCompletionsPrivate(extractOpenAIChatCompletionsPrivate(source), context);
  const events = async function* () { for await (const frame of encoded) if (frame.type === 'event') yield frame.event; };
  const result = await reassembleOpenAIChatCompletionsEvents(events());
  const message = result.choices[0].message as OpenAIChatCompletionsAssistantMessageEx;
  expect(message.reasoning).toBe('AB');
  const details = message.reasoning_details as Array<{ type: string; data?: string; summary?: string }>;
  expect(details.map(detail => detail.type)).toEqual(['reasoning.summary', 'reasoning.encrypted']);
  expect(await context.codec.unencapsulate(details[1].data)).not.toHaveProperty('reasoningText');
  const payload: OpenAIChatCompletionsPayload = { model: 'm', messages: [message] };
  await decodeOpenAIChatCompletionsPrivateHistory(payload, context);
  restoreOpenAIChatCompletionsPrivateHistory(payload);
  expect(message.reasoning_text).toBe('AB');
  expect(message.provider_specific_fields).toEqual({ mode: 'original' });
  expect(Object.hasOwn(message, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(message)).toBe(Object.prototype);
  expect((message.tool_calls?.[0] as unknown as Record<string, unknown>).custom_metadata).toBe(42);
});

test('foreign Chat history passes through unchanged when no sidecar is accepted', async () => {
  const message: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'answer', reasoning: 'foreign', reasoning_details: [{ type: 'reasoning.encrypted', data: 'foreign:opaque' }] };
  const payload: OpenAIChatCompletionsPayload = { model: 'm', messages: [message] };
  const original = structuredClone(payload);
  await decodeOpenAIChatCompletionsPrivateHistory(payload, context);
  expect(payload).toEqual(original);
  expect(message[OpenAIChatCompletionsAssistantMessagePrivate]).toBeUndefined();
});

test.each(['reasoning', 'reasoning_text', 'reasoning_content'] as const)('restores authenticated %s before applying the configured DeepSeek wire dialect', async field => {
  initRepo(new InMemoryRepo());
  const data = await context.codec.encapsulate({ sidecar: { upstreamProtocol: 'openaiChatCompletions', textFieldOriginalName: field } });
  const message: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: null, reasoning: 'trace', reasoning_details: [{ type: 'reasoning.encrypted', data }], tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] };
  const payload: OpenAIChatCompletionsPayload = { model: 'm', messages: [message, { role: 'tool', tool_call_id: 'call', content: 'result' }] };
  const source = structuredClone(payload);
  let body: Omit<OpenAIChatCompletionsPayload, 'model'> | undefined;
  const provider = stubProvider({
    callOpenAIChatCompletions: async (_model, request) => {
      body = request;
      return { ok: true, modelKey: 'key', headers: new Headers(), events: frames([chunk({ role: 'assistant', content: 'answer' }, 'stop'), doneFrame()]) };
    },
  });
  const candidate = stubModelCandidate({ enabledFlags: new Set(['vendor-deepseek']), model: { endpoints: { openaiChatCompletions: {} } }, provider: { ...stubModelCandidate().provider, instance: provider } });
  const result = await openaiChatCompletionsAttempt.generate({ payload, candidate, ctx: mockChatGatewayCtx({ assistantMessagePrivate: context }), headers: new Headers(), privateContext: context });
  if (result.type !== 'events') throw new Error(`Unexpected attempt result: ${result.type}`);
  await collect(result.events);
  expect(body?.messages[0]).toMatchObject({ role: 'assistant', reasoning_content: 'trace', tool_calls: [{ id: 'call' }] });
  expect(body?.messages[0]).not.toHaveProperty('reasoning_text');
  expect(body?.messages[0]).not.toHaveProperty('reasoning');
  expect(payload).toEqual(source);
});
