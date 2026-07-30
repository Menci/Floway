import { test } from 'vitest';

import { createResponsesToChatCompletionsStreamState, translateResponsesEventToChatCompletionsChunks, translateToSourceEvents } from '../../src/chat-completions-via-responses/events.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

// Local stand-in for `chatCompletionsProtocolFrameToSSEFrame`: the behavior
// under test is the translate output's terminal-frame discipline, not the SSE
// projection itself.
const isUsageOnlyChunk = (frame: ProtocolFrame<ChatCompletionsStreamEvent>): boolean =>
  frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage !== undefined;

const chatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>, options: { includeUsageChunk: boolean }): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isUsageOnlyChunk(frame)) return null;
  return sseFrame(JSON.stringify(frame.event));
};

const makeResponse = (status: ResponsesResult['status']): ResponsesResult => ({
  id: 'resp_123',
  object: 'response',
  model: 'gpt-test',
  status,
  output_text: 'hello',
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

const toProtocolFrame = (event: ResponsesStreamEvent): ProtocolFrame<ResponsesStreamEvent> => eventFrame({ ...event, sequence_number: 0 });

const includeUsageChunk = { includeUsageChunk: true };

const chatSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>) {
  for await (const frame of translateToSourceEvents(frames)) {
    const sse = chatCompletionsProtocolFrameToSSEFrame(frame, includeUsageChunk);
    if (sse) yield sse;
  }
};

const countDoneSentinels = async (frames: ProtocolFrame<ResponsesStreamEvent>[]): Promise<number> => {
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (const frame of chatSseFrames(stream())) {
    if (frame.data === '[DONE]') doneCount++;
  }

  return doneCount;
};

const countAssistantStartChunksAndDone = async (frames: ProtocolFrame<ResponsesStreamEvent>[]): Promise<{ assistantStartCount: number; doneCount: number }> => {
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

test('Responses to Chat translation rejects malformed inclusive cache counts', async () => {
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
    yield* responsesResultToEvents({
      id: 'resp_refusal',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output_text: '',
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

test('translateToSourceEvents preserves deferred reasoning and stream usage', async () => {
  async function* stream() {
    yield* [
      toProtocolFrame({
        type: 'response.created',
        response: {
          ...makeResponse('in_progress'),
          id: 'resp_deferred_reasoning',
          output_text: '',
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
          output_text: 'answer',
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

  const frames = await collect(translateToSourceEvents(stream()));
  const events = [];
  for (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }

  assertEquals(
    events.slice(0, -1).map(event => event.choices[0]?.delta),
    [
      { role: 'assistant' },
      { reasoning_text: 'trace' },
      {
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_0',
            summary: [{ type: 'summary_text', text: 'trace' }],
          },
        ],
      },
      { content: 'answer' },
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

test('translateToSourceEvents stops after Responses terminal completion', async () => {
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

test('translateToSourceEvents translates Responses error events to Chat errors', async () => {
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

test('translateToSourceEvents translates Responses failed terminal events to Chat errors', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.failed',
      response: {
        ...makeResponse('failed'),
        output_text: '',
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

test('translateToSourceEvents rejects truncated Responses streams without terminal events', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
    });
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream Responses stream ended without a terminal event.');
});

test('translateResponsesEventToChatCompletionsChunks drops reasoning items without readable summary', () => {
  const state = createResponsesToChatCompletionsStreamState();

  const created = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_single_opaque',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );
  assertEquals(created.length, 1);
  assertEquals(created[0].choices[0].delta.role, 'assistant');

  const during = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
      },
    },
    state,
  );
  assertEquals(during, []);

  const completed = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_single_opaque',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
        },
      },
    },
    state,
  );

  assertEquals(completed.length, 2);
  assertEquals(completed[0].choices[0].delta, {});
  assertEquals(completed[0].choices[0].finish_reason, 'stop');
  assertEquals(completed[0].usage, undefined);
  assertEquals(completed[1].choices, []);
  assertEquals(completed[1].usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
});

test('translateResponsesEventToChatCompletionsChunks does not fill scalar opaque from later empty reasoning', () => {
  const state = createResponsesToChatCompletionsStreamState();

  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_stream_no_cross_pair',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  const chunks = [
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'first',
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
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
    translateResponsesEventToChatCompletionsChunks(
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

  const completed = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_stream_no_cross_pair',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  assertEquals(
    [...chunks, ...completed].some(chunk => chunk.choices[0]?.delta.reasoning_opaque !== undefined),
    false,
  );
  assertEquals(completed[0].usage, undefined);
});

test('translateResponsesEventToChatCompletionsChunks drops multiple reasoning items without readable summaries', () => {
  const state = createResponsesToChatCompletionsStreamState();

  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_multi_opaque',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  const firstReasoning = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
      },
    },
    state,
  );
  const secondReasoning = translateResponsesEventToChatCompletionsChunks(
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
  );

  const completed = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_multi_opaque',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
        },
      },
    },
    state,
  );

  assertEquals(firstReasoning, []);
  assertEquals(secondReasoning, []);
  assertEquals(completed.length, 2);
  assertEquals(completed[0].choices[0].finish_reason, 'stop');
  assertEquals(completed[0].usage, undefined);
  assertEquals(completed[1].choices, []);
  assertEquals(completed[1].usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
});

test('translateResponsesEventToChatCompletionsChunks projects done-only summary text into scalar reasoning_text', () => {
  const state = createResponsesToChatCompletionsStreamState();

  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_done_only_summary',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );
  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      text: 'done trace',
    },
    state,
  );
  const reasoning = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'done trace' }],
      },
    },
    state,
  );

  const completed = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_done_only_summary',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  assertEquals(reasoning[0].choices[0].delta.reasoning_text, 'done trace');
  assertEquals(reasoning[1].choices[0].delta.reasoning_items, [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'done trace' }],
    },
  ]);
  assertEquals(completed[0].choices[0].finish_reason, 'stop');
});

test('translateResponsesEventToChatCompletionsChunks projects output_item.done summary into scalar reasoning_text', () => {
  const state = createResponsesToChatCompletionsStreamState();

  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_output_done_summary',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );
  const reasoning = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'output trace' }],
      },
    },
    state,
  );

  const completed = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_output_done_summary',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  assertEquals(reasoning[0].choices[0].delta.reasoning_text, 'output trace');
  assertEquals(reasoning[1].choices[0].delta.reasoning_items, [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'output trace' }],
    },
  ]);
  assertEquals(completed[0].choices[0].finish_reason, 'stop');
});

test('translateResponsesEventToChatCompletionsChunks emits stream usage as a usage-only chunk', () => {
  const state = createResponsesToChatCompletionsStreamState();

  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_usage_only',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  const completed = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_usage_only',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
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

test('translateResponsesEventToChatCompletionsChunks preserves text order around empty reasoning', () => {
  const state = createResponsesToChatCompletionsStreamState();
  const chunks = [
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_late_opaque_order',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [],
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.completed',
        response: {
          id: 'resp_late_opaque_order',
          object: 'response',
          model: 'gpt-test',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_0',
              summary: [],
            },
            {
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'answer', annotations: [] }],
            },
          ],
          output_text: 'answer',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
  ].flatMap(result => result);

  assertEquals(
    chunks.map(chunk => chunk.choices[0]?.delta),
    [
      { role: 'assistant' },
      { content: 'answer' },
      {},
    ],
  );
});

test('translateResponsesEventToChatCompletionsChunks preserves later text after empty reasoning is done', () => {
  const state = createResponsesToChatCompletionsStreamState();
  const chunks = [
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_done_before_text',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [],
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.completed',
        response: {
          id: 'resp_done_before_text',
          object: 'response',
          model: 'gpt-test',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_0',
              summary: [],
            },
            {
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'answer', annotations: [] }],
            },
          ],
          output_text: 'answer',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
  ].flatMap(result => result);

  assertEquals(
    chunks.map(chunk => chunk.choices[0]?.delta),
    [
      { role: 'assistant' },
      { content: 'answer' },
      {},
    ],
  );
});

test('translateResponsesEventToChatCompletionsChunks emits output_text.done when no delta arrived', () => {
  const state = createResponsesToChatCompletionsStreamState();
  const chunks = [
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_done_text',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
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

test('translateResponsesEventToChatCompletionsChunks emits function_call_arguments.done when no delta arrived', () => {
  const state = createResponsesToChatCompletionsStreamState();
  const chunks = [
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_done_args',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
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
    translateResponsesEventToChatCompletionsChunks(
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

test('translateResponsesEventToChatCompletionsChunks emits all done-only reasoning summary parts', () => {
  const state = createResponsesToChatCompletionsStreamState();
  const chunks = [
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_done_reasoning_parts',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        text: 'first',
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 1,
        text: 'second',
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [
            { type: 'summary_text', text: 'first' },
            { type: 'summary_text', text: 'second' },
          ],
        },
      },
      state,
    ),
  ].flatMap(result => result);

  assertEquals(
    chunks.map(chunk => chunk.choices[0]?.delta.reasoning_text).filter(text => text !== undefined),
    ['first', 'second'],
  );
});

test('translateResponsesEventToChatCompletionsChunks flushes pending done-only reasoning summary at completion', () => {
  const state = createResponsesToChatCompletionsStreamState();

  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.created',
      response: {
        id: 'resp_terminal_reasoning_done',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );
  translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_0',
      output_index: 0,
      summary_index: 0,
      text: 'terminal trace',
    },
    state,
  );
  const completed = translateResponsesEventToChatCompletionsChunks(
    {
      type: 'response.completed',
      response: {
        id: 'resp_terminal_reasoning_done',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
      },
    },
    state,
  );

  assertEquals(
    completed.map(chunk => chunk.choices[0]?.delta),
    [{ reasoning_text: 'terminal trace' }, {}],
  );
});

test('translateResponsesEventToChatCompletionsChunks keeps first scalar reasoning by output order', () => {
  const state = createResponsesToChatCompletionsStreamState();
  const chunks = [
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.created',
        response: {
          id: 'resp_reasoning_order',
          object: 'response',
          model: 'gpt-test',
          status: 'in_progress',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'second' }],
        },
      },
      state,
    ),
    translateResponsesEventToChatCompletionsChunks(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'first' }],
        },
      },
      state,
    ),
  ].flatMap(result => result);

  assertEquals(
    chunks.map(chunk => chunk.choices[0]?.delta),
    [
      { role: 'assistant' },
      { reasoning_text: 'first' },
      {
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_0',
            summary: [{ type: 'summary_text', text: 'first' }],
          },
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'second' }],
          },
        ],
      },
    ],
  );
});
