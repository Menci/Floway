import { expect, test } from 'vitest';

import { translateToSourceEvents } from '../../src/openai-chat-completions-via-openai-responses/events.ts';
import { buildTargetRequest } from '../../src/openai-chat-completions-via-openai-responses/request.ts';
import { structuredResponsesFixture } from '../shared/ir/responses-fixture.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';
import { eventFrame, type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, parseOpenAIChatCompletionsStream, openaiChatCompletionsProtocolFrameToSSEFrame as writeChatFrame, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesResultToEvents, parseOpenAIResponsesStream, collectOpenAIResponsesProtocolEventsToResult, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

// Local stand-in for `openaiChatCompletionsProtocolFrameToSSEFrame`: the behavior
// under test is the translate output's terminal-frame discipline, not the SSE
// projection itself.
const isUsageOnlyChunk = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>): boolean =>
  frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage !== undefined;

const openaiChatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>, options: { includeUsageChunk: boolean }): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isUsageOnlyChunk(frame)) return null;
  return sseFrame(JSON.stringify(frame.event));
};

const makeResponse = (status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_123',
  object: 'response',
  model: 'gpt-test',
  status,
  output: [
    {
      type: 'message',
      id: 'msg_base',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }],
    },
  ],
  error: null,
  incomplete_details: null,
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  },
});

const toProtocolFrame = (event: OpenAIResponsesStreamEventEx): ProtocolFrame<OpenAIResponsesStreamEventEx> => eventFrame({ ...event, sequence_number: 0 });

const includeUsageChunk = { includeUsageChunk: true };

const chatSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>) {
  for await (const frame of translateToSourceEvents(structuredResponsesFixture(frames))) {
    const sse = openaiChatCompletionsProtocolFrameToSSEFrame(frame, includeUsageChunk);
    if (sse) yield sse;
  }
};

const countDoneSentinels = async (frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): Promise<number> => {
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (const frame of chatSseFrames(stream())) {
    if (frame.data === '[DONE]') doneCount++;
  }

  return doneCount;
};

const countAssistantStartChunksAndDone = async (frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): Promise<{ assistantStartCount: number; doneCount: number }> => {
  let assistantStartCount = 0;
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (const frame of chatSseFrames(stream())) {
    if (frame.data === '[DONE]') {
      doneCount++;
      continue;
    }

    const parsed = JSON.parse(frame.data) as {
      choices?: Array<{ delta?: { role?: string } }>;
    };
    if (parsed.choices?.[0]?.delta?.role === 'assistant') assistantStartCount++;
  }

  return { assistantStartCount, doneCount };
};

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

const collect = async <T>(frames: AsyncIterable<T>): Promise<T[]> => {
  const collected = [];
  for await (const frame of frames) collected.push(frame);
  return collected;
};

test('translateToSourceEvents emits exactly one [DONE] for structured responses stream', async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: 'response.created',
      response: makeResponse('in_progress'),
    }),
    toProtocolFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'hello',
    }),
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
  ]);

  assertEquals(doneCount, 1);
});

test('response.created service_tier survives when the terminal response omits it', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.created',
      response: { ...makeResponse('in_progress'), service_tier: 'priority' },
    });
    yield toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    });
  }

  const frames = await collect(translateToSourceEvents(structuredResponsesFixture(stream())));
  const events = frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
  assertEquals(events[0].service_tier, 'priority');
  assertEquals(events.at(-1)?.service_tier, 'priority');
});

test('OpenAI Responses to OpenAI Chat Completions translation rejects malformed inclusive cache counts', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.completed',
      response: {
        ...makeResponse('completed'),
        usage: {
          input_tokens: 40,
          output_tokens: 1,
          total_tokens: 41,
          input_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 },
        },
      },
    });
  }

  await assertRejects(
    async () => await drain(translateToSourceEvents(structuredResponsesFixture(stream()))),
    RangeError,
    'cache token counts exceed inclusive input tokens',
  );
});

test('translateToSourceEvents emits exactly one [DONE] for fallback completion stream', async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: 'response.output_text.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      text: 'hello',
    }),
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
  ]);

  assertEquals(doneCount, 1);
});

test('translateToSourceEvents avoids assistant-start duplication for created+completed fallback', async () => {
  const { assistantStartCount, doneCount } = await countAssistantStartChunksAndDone([
    toProtocolFrame({
      type: 'response.created',
      response: makeResponse('in_progress'),
    }),
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
  ]);

  assertEquals(assistantStartCount, 1);
  assertEquals(doneCount, 1);
});

test('translateToSourceEvents preserves refusal text from JSON fallback', async () => {
  async function* stream() {
    yield* openaiResponsesResultToEvents({
      id: 'resp_refusal',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_refusal',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'No.' }],
        },
      ],
      error: null,
      incomplete_details: null,
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
      },
    });
  }

  const refusal: string[] = [];

  for await (const frame of translateToSourceEvents(structuredResponsesFixture(stream()))) {
    if (frame.type !== 'event') continue;
    refusal.push(frame.event.choices[0]?.delta.refusal ?? '');
  }

  assertEquals(refusal.join(''), 'No.');
});

test('translateToSourceEvents streams independent text before deferred reasoning and retains usage', async () => {
  async function* stream() {
    yield* [
      toProtocolFrame({
        type: 'response.created',
        response: {
          ...makeResponse('in_progress'),
          id: 'resp_deferred_reasoning',
          output: [],
        },
      }),
      toProtocolFrame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      }),
      toProtocolFrame({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      }),
      toProtocolFrame({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      }),
      toProtocolFrame({
        type: 'response.completed',
        response: {
          ...makeResponse('completed'),
          id: 'resp_deferred_reasoning',
          output: [],
          service_tier: 'priority',
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16,
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
          },
        },
      }),
    ];
  }

  const frames = await collect(translateToSourceEvents(structuredResponsesFixture(stream())));
  const events = [];
  for (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }

  assertEquals(
    events.slice(0, -1).map(event => event.choices[0]?.delta),
    [
      { role: 'assistant', content: '' },
      { content: 'answer' },
      { reasoning_text: 'trace' },
      {},
      {
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_0',
            summary: [{ type: 'summary_text', text: 'trace' }],
          },
        ],
      },
    ],
  );

  assertEquals(events.at(-1)?.choices, []);
  assertEquals(events.at(-1)?.usage, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3, cache_creation_input_tokens: 2 },
  });
  assertEquals(events.at(-2)?.service_tier, 'priority');
  assertEquals(events.at(-1)?.service_tier, 'priority');
  assertEquals(frames.at(-1)?.type, 'done');
});

test('translateToSourceEvents stops after OpenAI Responses terminal completion', async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
    toProtocolFrame({
      type: 'error',
      message: 'ignored after terminal',
      code: 'ignored_error',
    }),
  ]);

  assertEquals(doneCount, 1);
});

test('translateToSourceEvents translates OpenAI Responses error events to OpenAI Chat Completions errors', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'error',
      message: 'upstream overloaded',
      code: 'overloaded_error',
    });
  }

  const frames = await collect(translateToSourceEvents(structuredResponsesFixture(stream())));

  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, 'event');
  if (frames[0].type !== 'event') throw new Error('expected event frame');
  assertEquals((frames[0].event as unknown as Record<string, unknown>).error, {
    message: 'upstream overloaded',
    type: 'overloaded_error',
    code: 'overloaded_error',
  });
});

test('translateToSourceEvents translates OpenAI Responses failed terminal events to OpenAI Chat Completions errors', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.failed',
      response: {
        ...makeResponse('failed'),
        output: [],
        error: {
          type: 'server_error',
          code: 'server_error',
          message: 'upstream failed',
        },
      },
    });
  }

  const frames = await collect(translateToSourceEvents(structuredResponsesFixture(stream())));

  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, 'event');
  if (frames[0].type !== 'event') throw new Error('expected event frame');
  assertEquals((frames[0].event as unknown as Record<string, unknown>).error, {
    message: 'upstream failed',
    type: 'server_error',
    code: 'server_error',
  });
});

test.each(['flat error', 'nested error', 'failed response'])('translateToSourceEvents preserves the error provider namespace without copying (%s)', async path => {
  const provider_specific_fields = {
    name: 'TranslatorInputError',
    stack: 'translator stack',
    cause: { message: 'source failed', cause: { code: 17, details: [false, null, { value: 'nested' }] } },
    target_api: 'openai-responses',
    upstream_metadata: { retryable: false, values: ['first', 2] },
  };
  const error = { type: 'server_error', code: 'upstream_failure', message: 'upstream failed', provider_specific_fields, name: 'legacy name', stack: 'legacy stack', cause: { message: 'legacy cause' }, target_api: 'legacy target' };
  const event: OpenAIResponsesStreamEventEx = path === 'flat error'
    ? { ...error, type: 'error' }
    : path === 'nested error'
      ? { type: 'error', error }
      : { type: 'response.failed', response: { ...makeResponse('failed'), error } };
  async function* stream() {
    yield toProtocolFrame(event);
  }
  const frames = await collect(translateToSourceEvents(structuredResponsesFixture(stream())));
  expect(frames).toHaveLength(1);
  if (frames[0].type !== 'event') throw new Error('expected error event frame');
  const translated = (frames[0].event as unknown as { error: Record<string, unknown> }).error;
  expect(translated).toEqual({
    message: error.message,
    type: path === 'flat error' ? error.code : error.type,
    code: error.code,
    provider_specific_fields,
  });
  expect(translated.provider_specific_fields).toBe(provider_specific_fields);
  const sse = writeChatFrame(frames[0], includeUsageChunk);
  if (sse === null) throw new Error('expected error SSE frame');
  expect(JSON.parse(sse.data)).toEqual({ error: translated });
});

test('translateToSourceEvents rejects truncated OpenAI Responses streams without terminal events', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
    });
  }

  await assertRejects(async () => await drain(translateToSourceEvents(structuredResponsesFixture(stream()))), Error, 'Responses stream ended without a terminal response');
});

test.each([false, true].flatMap(mixed => [
  { mixed, delivery: 'deltas', initialInput: '', deltas: ['patch ', 'text'], inputDone: true },
  { mixed, delivery: 'initial prefix and delta', initialInput: 'patch ', deltas: ['text'], inputDone: true },
  { mixed, delivery: 'initial prefix and input done', initialInput: 'patch ', deltas: [], inputDone: true },
  { mixed, delivery: 'initial prefix and item done', initialInput: 'patch ', deltas: [], inputDone: false },
  { mixed, delivery: 'item done only', initialInput: '', deltas: [], inputDone: false },
]))('native custom call SSE survives Chat client collection and replay (mixed=$mixed, delivery=$delivery)', async ({ mixed, initialInput, deltas, inputDone }) => {
  const custom = { type: 'custom_tool_call' as const, id: 'ctc_1', call_id: 'call_edit', name: 'edit', input: 'patch text', status: 'completed' };
  const fn = { type: 'function_call' as const, id: 'fc_1', call_id: 'call_lookup', name: 'lookup', arguments: '{}', status: 'completed' };
  const index = mixed ? 1 : 0;
  const response = { ...makeResponse('completed'), output: mixed ? [fn, custom] : [custom] };
  const events: OpenAIResponsesStreamEventEx[] = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    ...(mixed ? [{ type: 'response.output_item.added' as const, output_index: 0, item: { ...fn, status: 'in_progress', arguments: '' } }] : []),
    { type: 'response.output_item.added', output_index: index, item: { ...custom, status: 'in_progress', input: initialInput } },
    ...(deltas.length > 0 ? [{ type: 'response.custom_tool_call_input.delta' as const, output_index: index, item_id: custom.id, delta: deltas[0] }] : []),
    ...(mixed ? [{ type: 'response.function_call_arguments.delta' as const, output_index: 0, item_id: fn.id, delta: '{}' }] : []),
    ...deltas.slice(1).map(delta => ({ type: 'response.custom_tool_call_input.delta' as const, output_index: index, item_id: custom.id, delta })),
    ...(inputDone ? [{ type: 'response.custom_tool_call_input.done' as const, output_index: index, item_id: custom.id, input: custom.input }] : []),
    ...(mixed ? [{ type: 'response.output_item.done' as const, output_index: 0, item: fn }] : []),
    { type: 'response.output_item.done', output_index: index, item: custom },
    { type: 'response.completed', response },
  ];
  const upstreamSSE = events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
  const upstream = await collectOpenAIResponsesProtocolEventsToResult(parseOpenAIResponsesStream(new Response(upstreamSSE).body!));
  let clientSSE = '';
  for await (const frame of translateToSourceEvents(parseOpenAIResponsesStream(new Response(upstreamSSE).body!))) {
    const sse = writeChatFrame(frame, includeUsageChunk);
    if (sse) clientSSE += `data: ${sse.data}\n\n`;
  }
  const client = await collectOpenAIChatCompletionsProtocolEventsToResult(parseOpenAIChatCompletionsStream(new Response(clientSSE).body!));
  expect(client.choices[0].finish_reason).toBe('tool_calls');
  const replay = buildTargetRequest({ model: response.model, messages: [client.choices[0].message, { role: 'tool', tool_call_id: custom.call_id, content: 'edited' }] });
  expect(replay.input.slice(0, -1)).toEqual(upstream.output.map(({ id: _id, ...item }) => item));
  expect(replay.input.at(-1)).toEqual({ type: 'custom_tool_call_output', call_id: custom.call_id, output: 'edited' });
});

testOutputTranslation('openai-chat-completions', 'openai-responses', frames => translateToSourceEvents(structuredResponsesFixture(frames)));
