import { expect, test } from 'vitest';

import { openaiChatCompletionsSourceProtocol } from '../../../src/protocols/openai-chat-completions/as-source.ts';
import { openaiResponsesTargetProtocol } from '../../../src/protocols/openai-responses/as-target.ts';
import { buildSourceEventsFor, buildTargetPayloadFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { testOutputTranslation } from '../fixtures.ts';
import { structuredResponsesFixture } from '../openai-responses/fixtures.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, parseOpenAIChatCompletionsStream, openaiChatCompletionsProtocolFrameToSSEFrame as writeChatFrame } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, collectOpenAIResponsesProtocolEventsToResult, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const makeResponse = (status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_123',
  object: 'response',
  model: 'gpt-test',
  status,
  output: [
    {
      type: 'message',
      id: 'msg_1',
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

const translate = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>) => buildSourceEventsFor(
  pairs.chatToResponses[0], pairs.chatToResponses[1], emptyPayload.chat,
  { sidecarCodec: createTestSidecarCodec() },
  structuredResponsesFixture(frames),
);

const collect = async <T>(frames: AsyncIterable<T>): Promise<T[]> => {
  const collected = [];
  for await (const frame of frames) collected.push(frame);
  return collected;
};

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

  const frames = await collect(translate(stream()));
  const events = frames.flatMap(frame => frame.type === 'event' && !('error' in frame.event) ? [frame.event] : []);
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
    async () => await collect(translate(stream())),
    RangeError,
    'cache token counts exceed inclusive input tokens',
  );
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
          output: [
            { type: 'reasoning', id: 'rs_0', summary: [{ type: 'summary_text', text: 'trace' }] },
            { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [], logprobs: [] }] },
          ],
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

  const frames = await collect(translate(stream()));
  const events = [];
  for (const frame of frames) {
    if (frame.type === 'event' && !('error' in frame.event)) events.push(frame.event);
  }

  assertEquals(
    events.slice(0, -1).map(event => event.choices[0]?.delta),
    [
      { role: 'assistant', content: '' },
      { content: 'answer' },
      { reasoning_text: 'trace' },
      {
        reasoning_details: [
          {
            type: 'reasoning.summary',
            summary: 'trace',
            format: 'unknown',
            index: 0,
          },
        ],
      },
      {
        reasoning_details: [
          {
            type: 'reasoning.encrypted',
            data: expect.any(String),
            format: 'unknown',
            index: 1,
          },
        ],
      },
      {},
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

test.each(['flat error', 'nested error', 'failed response'])('translateToSourceEvents preserves the error provider namespace and colliding loose fields (%s)', async path => {
  const provider_specific_fields = {
    name: 'TranslateInputException',
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
  const frames = await collect(translate(stream()));
  expect(frames).toHaveLength(1);
  if (frames[0].type !== 'event') throw new Error('expected error event frame');
  const translated = (frames[0].event as unknown as { error: Record<string, unknown> }).error;
  expect(translated).toEqual({
    message: error.message,
    ...(path === 'flat error' ? {} : { type: error.type }),
    code: error.code,
    provider_specific_fields: {
      ...provider_specific_fields,
      name_1: error.name, stack_1: error.stack, cause_1: error.cause, target_api_1: error.target_api,
    },
  });
  const sse = writeChatFrame(frames[0], includeUsageChunk);
  if (sse === null) throw new Error('expected error SSE frame');
  expect(JSON.parse(sse.data)).toEqual({ error: translated });
});

test.each([
  { mixed: false, delivery: 'deltas', initialInput: '', deltas: ['patch ', 'text'], inputDone: true },
  { mixed: true, delivery: 'initial prefix and delta', initialInput: 'patch ', deltas: ['text'], inputDone: true },
  { mixed: false, delivery: 'initial prefix and item done', initialInput: 'patch ', deltas: [], inputDone: false },
  { mixed: true, delivery: 'item done only', initialInput: '', deltas: [], inputDone: false },
])('native custom call SSE survives Chat client collection and replay (mixed=$mixed, delivery=$delivery)', async ({ mixed, initialInput, deltas, inputDone }) => {
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
  for await (const frame of translate(parseOpenAIResponsesStream(new Response(upstreamSSE).body!))) {
    const sse = writeChatFrame(frame, includeUsageChunk);
    if (sse) clientSSE += `data: ${sse.data}\n\n`;
  }
  const client = await collectOpenAIChatCompletionsProtocolEventsToResult(parseOpenAIChatCompletionsStream(new Response(clientSSE).body!));
  expect(client.choices[0].finish_reason).toBe('tool_calls');
  const replay = await buildTargetPayloadFor(openaiChatCompletionsSourceProtocol, openaiResponsesTargetProtocol, { model: response.model, stream: true, messages: [client.choices[0].message, { role: 'tool', tool_call_id: custom.call_id, content: 'edited' }] }, { sidecarCodec: createTestSidecarCodec() });
  expect(replay.input.slice(0, -1)).toEqual(upstream.output);
  expect(replay.input.at(-1)).toEqual({ type: 'custom_tool_call_output', call_id: custom.call_id, output: 'edited' });
});

testOutputTranslation('openai-chat-completions', 'openai-responses', (frames, codec) => {
  const [source, target] = pairs.chatToResponses;
  return buildSourceEventsFor(source, target, emptyPayload.chat, { sidecarCodec: codec }, structuredResponsesFixture(frames));
});
