import { test } from 'vitest';

import { createOpenAIResponsesToOpenAIChatCompletionsStreamState, translateOpenAIResponsesEventToOpenAIChatCompletionsChunks, translateToSourceEvents } from '../../src/openai-chat-completions-via-openai-responses/events.ts';
import { eventFrame, type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesResultToEvents, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
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
  for await (const frame of translateToSourceEvents(frames)) {
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

  const frames = await collect(translateToSourceEvents(stream()));
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
    async () => await drain(translateToSourceEvents(stream())),
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

  for await (const frame of translateToSourceEvents(stream())) {
    if (frame.type !== 'event') continue;
    refusal.push(frame.event.choices[0]?.delta.refusal ?? '');
  }

  assertEquals(refusal.join(''), 'No.');
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

  const frames = await collect(translateToSourceEvents(stream()));

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

  const frames = await collect(translateToSourceEvents(stream()));

  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, 'event');
  if (frames[0].type !== 'event') throw new Error('expected event frame');
  assertEquals((frames[0].event as unknown as Record<string, unknown>).error, {
    message: 'upstream failed',
    type: 'server_error',
    code: 'server_error',
  });
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

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream OpenAI Responses stream ended without a terminal event.');
});

test('Responses translation keeps replay data private until the terminal event', () => {
  const state = createOpenAIResponsesToOpenAIChatCompletionsStreamState();

  translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_stream_no_cross_pair',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  const chunks = [
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'first',
      },
      state,
    ),
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'first' }],
        },
      },
      state,
    ),
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'reasoning',
          id: 'rs_2',
          summary: [],
        },
      },
      state,
    ),
  ].flatMap(result => result);

  const completed = translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_stream_no_cross_pair',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  assertEquals(
    chunks.some(chunk => (chunk.choices[0]?.delta as OpenAIChatCompletionsAssistantDelta)[OpenAIChatCompletionsAssistantMessagePrivate]?.sidecar !== undefined),
    false,
  );
  assertEquals((completed[0].choices[0].delta as OpenAIChatCompletionsAssistantDelta)[OpenAIChatCompletionsAssistantMessagePrivate]?.sidecar?.upstreamProtocol, 'openaiResponses');
});

test('translateOpenAIResponsesEventToOpenAIChatCompletionsChunks emits stream usage as a usage-only chunk', () => {
  const state = createOpenAIResponsesToOpenAIChatCompletionsStreamState();

  translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_usage_only',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  const completed = translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_usage_only',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        error: null,
        incomplete_details: null,
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 3 },
        },
      },
    },
    state,
  );

  assertEquals(completed.length, 2);
  assertEquals(completed[0].choices[0].finish_reason, 'stop');
  assertEquals(completed[0].usage, undefined);
  assertEquals(completed[1].choices, []);
  assertEquals(completed[1].usage, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3 },
  });
});

test('translateOpenAIResponsesEventToOpenAIChatCompletionsChunks emits output_text.done when no delta arrived', () => {
  const state = createOpenAIResponsesToOpenAIChatCompletionsStreamState();
  const chunks = [
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_done_text',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.output_text.done',
        item_id: 'msg_0',
        output_index: 0,
        content_index: 0,
        text: 'answer',
      },
      state,
    ),
  ].flatMap(result => result);

  assertEquals(
    chunks.map(chunk => chunk.choices[0]?.delta),
    [{ role: 'assistant' }, { content: 'answer' }],
  );
});

test('translateOpenAIResponsesEventToOpenAIChatCompletionsChunks emits function_call_arguments.done when no delta arrived', () => {
  const state = createOpenAIResponsesToOpenAIChatCompletionsStreamState();
  const chunks = [
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_done_args',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_0',
          name: 'lookup',
          arguments: '',
          status: 'in_progress',
        },
      },
      state,
    ),
    translateOpenAIResponsesEventToOpenAIChatCompletionsChunks(
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_0',
        output_index: 0,
        arguments: '{"q":1}',
      },
      state,
    ),
  ].flatMap(result => result);

  assertEquals(
    chunks.map(chunk => chunk.choices[0]?.delta),
    [
      { role: 'assistant' },
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_0',
            type: 'function',
            function: { name: 'lookup', arguments: '' },
          },
        ],
      },
      {
        tool_calls: [
          {
            index: 0,
            function: { arguments: '{"q":1}' },
          },
        ],
      },
    ],
  );
});
