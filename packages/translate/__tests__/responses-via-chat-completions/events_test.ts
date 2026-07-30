import { expect, test } from 'vitest';

import { createChatCompletionsToResponsesStreamState, flushChatCompletionsToResponsesEvents, translateChatCompletionsChunkToResponsesEvents, translateToSourceEvents } from '../../src/responses-via-chat-completions/events.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

type ResponsesCompletedEvent = Extract<ResponsesStreamEvent, { type: 'response.completed' }>;

type ResponsesIncompleteEvent = Extract<ResponsesStreamEvent, { type: 'response.incomplete' }>;

type ResponsesOutputItemAddedEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;

type ResponsesOutputItemDoneEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;

const chunk = (
  delta: ChatCompletionsStreamEvent['choices'][0]['delta'],
  finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null,
  usage?: ChatCompletionsStreamEvent['usage'],
): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_stream_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});

const translate = (chunks: ChatCompletionsStreamEvent[]): ResponsesStreamEvent[] => {
  const state = createChatCompletionsToResponsesStreamState();
  return [...chunks.flatMap(item => translateChatCompletionsChunkToResponsesEvents(item, state)), ...flushChatCompletionsToResponsesEvents(state)];
};

const sequenceNumbers = (events: ResponsesStreamEvent[]): number[] => events.map(event => (event as ResponsesStreamEvent & { sequence_number: number }).sequence_number);

const assertEveryAddedOutputItemIsDone = (events: ResponsesStreamEvent[]): void => {
  const added = events
    .filter((event): event is ResponsesOutputItemAddedEvent => event.type === 'response.output_item.added')
    .map(event => event.output_index)
    .sort((a, b) => a - b);
  const done = events
    .filter((event): event is ResponsesOutputItemDoneEvent => event.type === 'response.output_item.done')
    .map(event => event.output_index)
    .sort((a, b) => a - b);

  assertEquals(done, added);
};

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateChatCompletionsChunkToResponsesEvents preserves refusal output lifecycle', () => {
  const events = translate([
    chunk({ role: 'assistant', content: null, refusal: '' }),
    chunk({ refusal: 'Cannot ' }),
    chunk({ refusal: 'help.' }),
    chunk({}, 'stop'),
  ]);
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;

  assertEquals(events.filter(event => event.type === 'response.refusal.delta').map(event => (event as Extract<ResponsesStreamEvent, { type: 'response.refusal.delta' }>).delta), ['Cannot ', 'help.']);
  assertEquals(completed?.response.output, [{
    type: 'message',
    id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'refusal', refusal: 'Cannot help.' }],
  }]);
  assertEquals(completed?.response.output_text, '');
});

test('translateChatCompletionsChunkToResponsesEvents preserves an empty refusal item', () => {
  const events = translate([
    chunk({ role: 'assistant', content: null, refusal: '' }),
    chunk({}, 'stop'),
  ]);
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;

  assertEquals(completed?.response.output, [{
    type: 'message',
    id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'refusal', refusal: '' }],
  }]);
});

test('translateChatCompletionsChunkToResponsesEvents preserves tool call deltas and terminal output', () => {
  const events = translate([
    chunk({ role: 'assistant' }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q"' },
        },
      ],
    }),
    chunk({
      tool_calls: [
        {
          index: 0,
          function: { arguments: ':"x"}' },
        },
      ],
    }),
    chunk({}, 'tool_calls'),
  ]);

  const argumentDeltas = events.filter(event => event.type === 'response.function_call_arguments.delta') as Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>[];
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;

  assertEquals(
    argumentDeltas.map(event => event.delta),
    ['{"q"', ':"x"}'],
  );
  assertEquals(completed?.response.output, [
    {
      type: 'function_call',
      id: expect.stringMatching(/^fc_[0-9a-f]{32}$/),
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
      status: 'completed',
    },
  ]);
  assertEquals(
    sequenceNumbers(events),
    events.map((_, index) => index),
  );
});

test('translateChatCompletionsChunkToResponsesEvents replaces buffered scalar reasoning with carrier items', () => {
  const events = translate([
    chunk({ role: 'assistant' }),
    chunk({ reasoning_text: 'trace' }),
    chunk({ content: 'answer' }),
    chunk({
      reasoning_items: [
        {
          type: 'reasoning',
          id: 'rs_carrier',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      ],
    }),
    chunk({}, 'stop'),
  ]);

  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;

  assertEquals(completed?.response.output, [
    {
      type: 'reasoning',
      id: 'rs_carrier',
      summary: [{ type: 'summary_text', text: 'trace' }],
    },
    {
      type: 'message',
      id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer', annotations: [] }],
    },
  ]);
});

test('translateChatCompletionsChunkToResponsesEvents maps usage on incomplete length terminal', () => {
  const events = translate([
    chunk({ role: 'assistant' }),
    chunk({ content: 'partial' }),
    chunk({}, 'length', {
      prompt_tokens: 4,
      completion_tokens: 6,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 1, cache_creation_input_tokens: 2 },
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
        reasoning_tokens: 2,
      },
    }),
  ]);

  const incomplete = events.find(event => event.type === 'response.incomplete') as ResponsesIncompleteEvent | undefined;

  assertEquals(incomplete?.response.status, 'incomplete');
  assertEquals(incomplete?.response.incomplete_details, {
    reason: 'max_output_tokens',
  });
  assertEquals(incomplete?.response.usage, {
    input_tokens: 4,
    output_tokens: 6,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 2 },
  });
});

test.each([
  [{ cache_write_tokens: 2 }, 2],
  [{ cache_creation_input_tokens: 3, cache_write_tokens: 2 }, 3],
] as const)('translateChatCompletionsChunkToResponsesEvents maps Chat cache-write detail %o', (promptTokensDetails, expectedWrite) => {
  const events = translate([
    chunk({ role: 'assistant' }),
    chunk({}, 'stop', {
      prompt_tokens: 4,
      completion_tokens: 1,
      total_tokens: 5,
      prompt_tokens_details: promptTokensDetails,
    }),
  ]);
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;
  assertEquals(completed?.response.usage?.input_tokens_details, { cached_tokens: 0, cache_write_tokens: expectedWrite });
});

test('translateChatCompletionsChunkToResponsesEvents rejects malformed inclusive cache counts', () => {
  expect(() => translate([
    chunk({ role: 'assistant' }),
    chunk({}, 'stop', {
      prompt_tokens: 40,
      completion_tokens: 1,
      total_tokens: 41,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 },
    }),
  ])).toThrowError(RangeError);
});

test('translateChatCompletionsChunkToResponsesEvents preserves response service_tier', () => {
  const terminal = {
    ...chunk({}, 'stop', { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
    service_tier: 'priority',
  } satisfies ChatCompletionsStreamEvent;
  const events = translate([chunk({ role: 'assistant' }), terminal]);
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;
  assertEquals(completed?.response.service_tier, 'priority');
});

test('translateToSourceEvents rejects Chat streams without DONE', async () => {
  async function* stream() {
    yield eventFrame({
      id: 'chatcmpl_truncated',
      object: 'chat.completion.chunk',
      created: 123,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'partial' },
          finish_reason: 'stop',
        },
      ],
    } satisfies ChatCompletionsStreamEvent);
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream Chat Completions stream ended without a DONE sentinel.');
});

test('translateChatCompletionsChunkToResponsesEvents unwraps wrapped custom tool calls into custom_tool_call shape', () => {
  const state = createChatCompletionsToResponsesStreamState(new Set(['apply_patch']));

  // Initial chunk announces the tool call name; wrapped tools should not emit
  // an incremental arguments delta even when args bytes already arrived.
  const startEvents = translateChatCompletionsChunkToResponsesEvents(
    {
      id: 'chatcmpl_ctc',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_ctc',
                type: 'function',
                function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    } satisfies ChatCompletionsStreamEvent,
    state,
  );

  // Only output_item.added should fire; no arguments delta.
  assertEquals(
    startEvents.map(e => e.type),
    ['response.created', 'response.in_progress', 'response.output_item.added'],
  );
  const added = startEvents.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }> => e.type === 'response.output_item.added');
  if (!added) throw new Error('expected output_item.added');
  assertEquals(added.item.type, 'custom_tool_call');

  // Second chunk completes the wrapped JSON; still no live delta.
  const continueEvents = translateChatCompletionsChunkToResponsesEvents(
    {
      id: 'chatcmpl_ctc',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '\\n*** End Patch"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    } satisfies ChatCompletionsStreamEvent,
    state,
  );
  assertEquals(continueEvents, []);

  const finalEvents = flushChatCompletionsToResponsesEvents(state);
  const types = finalEvents.map(e => e.type);
  assertEquals(types.includes('response.custom_tool_call_input.delta'), true);
  assertEquals(types.includes('response.custom_tool_call_input.done'), true);

  const itemDone = finalEvents.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> => e.type === 'response.output_item.done');
  if (!itemDone) throw new Error('expected output_item.done');
  assertEquals(itemDone.item.type, 'custom_tool_call');
  if (itemDone.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(itemDone.item.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.call_id, 'call_ctc');
});

test('translateChatCompletionsChunkToResponsesEvents keeps late opaque with prior scalar reasoning text', () => {
  const state = createChatCompletionsToResponsesStreamState();
  const events = [
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ role: 'assistant', reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ content: 'answer' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ reasoning_opaque: 'sig' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({}, 'stop'), state),
    ...flushChatCompletionsToResponsesEvents(state),
  ];

  const reasoningDoneEvents = events.filter(event => event.type === 'response.output_item.done' && (event as ResponsesOutputItemDoneEvent).item.type === 'reasoning') as ResponsesOutputItemDoneEvent[];

  assertEquals(reasoningDoneEvents.length, 1);
  assertEquals(reasoningDoneEvents[0].output_index, 0);
  assertEquals(reasoningDoneEvents[0].item, {
    type: 'reasoning',
    id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
});

test('translateChatCompletionsChunkToResponsesEvents prefers reasoning_items over scalar reasoning in streaming composition', () => {
  const state = createChatCompletionsToResponsesStreamState();
  const events = [
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ role: 'assistant' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ content: 'answer' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(
      chunk({
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_carrier',
            summary: [{ type: 'summary_text', text: 'trace' }],
          },
        ],
      }),
      state,
    ),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({}, 'stop'), state),
    ...flushChatCompletionsToResponsesEvents(state),
  ];

  const reasoningDoneEvents = events.filter(event => event.type === 'response.output_item.done' && (event as ResponsesOutputItemDoneEvent).item.type === 'reasoning') as ResponsesOutputItemDoneEvent[];
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;

  assertEveryAddedOutputItemIsDone(events);
  assertEquals(reasoningDoneEvents.length, 1);
  assertEquals(reasoningDoneEvents[0].item, {
    type: 'reasoning',
    id: 'rs_carrier',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  assertEquals(completed?.response.output, [
    {
      type: 'reasoning',
      id: 'rs_carrier',
      summary: [{ type: 'summary_text', text: 'trace' }],
    },
    {
      type: 'message',
      id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer', annotations: [] }],
    },
  ]);
});

test('translateChatCompletionsChunkToResponsesEvents keeps terminal output ordered by output_index', () => {
  const state = createChatCompletionsToResponsesStreamState();
  const events = [
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ role: 'assistant' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"x"}' },
          },
        ],
      }),
      state,
    ),
    ...translateChatCompletionsChunkToResponsesEvents(
      chunk({
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_after_tool',
            summary: [{ type: 'summary_text', text: 'trace' }],
          },
        ],
      }),
      state,
    ),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({}, 'tool_calls'), state),
    ...flushChatCompletionsToResponsesEvents(state),
  ];

  const added = events.filter(event => event.type === 'response.output_item.added') as ResponsesOutputItemAddedEvent[];
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;

  assertEquals(
    added.map(event => [event.output_index, event.item.type]),
    [
      [0, 'function_call'],
      [1, 'reasoning'],
    ],
  );
  assertEquals(
    completed?.response.output.map(item => item.type),
    ['function_call', 'reasoning'],
  );
});

test('translateChatCompletionsChunkToResponsesEvents discards scalar reasoning when carrier arrives after opaque', () => {
  const state = createChatCompletionsToResponsesStreamState();
  const events = [
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ role: 'assistant' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ content: 'answer' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({ reasoning_opaque: 'sig' }), state),
    ...translateChatCompletionsChunkToResponsesEvents(
      chunk({
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_carrier',
            summary: [{ type: 'summary_text', text: 'trace' }],
          },
        ],
      }),
      state,
    ),
    ...translateChatCompletionsChunkToResponsesEvents(chunk({}, 'stop'), state),
    ...flushChatCompletionsToResponsesEvents(state),
  ];

  const reasoningDoneEvents = events.filter(event => event.type === 'response.output_item.done' && (event as ResponsesOutputItemDoneEvent).item.type === 'reasoning') as ResponsesOutputItemDoneEvent[];
  const completed = events.find(event => event.type === 'response.completed') as ResponsesCompletedEvent | undefined;

  assertEveryAddedOutputItemIsDone(events);
  assertEquals(reasoningDoneEvents.length, 1);
  assertEquals(reasoningDoneEvents[0].item, {
    type: 'reasoning',
    id: 'rs_carrier',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  assertEquals(completed?.response.output, [
    {
      type: 'reasoning',
      id: 'rs_carrier',
      summary: [{ type: 'summary_text', text: 'trace' }],
    },
    {
      type: 'message',
      id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer', annotations: [] }],
    },
  ]);
});

test('translateChatCompletionsChunkToResponsesEvents ignores empty tool_calls arrays', () => {
  const state = createChatCompletionsToResponsesStreamState();
  const initialEvents = translateChatCompletionsChunkToResponsesEvents(chunk({ role: 'assistant', tool_calls: [] }), state);
  assertEquals(initialEvents.length, 2);
  assertEquals(initialEvents[0].type, 'response.created');
  assertEquals(initialEvents[1].type, 'response.in_progress');

  const contentEvents = translateChatCompletionsChunkToResponsesEvents(chunk({ content: 'hello' }), state);
  const addedEvents = contentEvents.filter(event => event.type === 'response.output_item.added') as ResponsesOutputItemAddedEvent[];
  assertEquals(addedEvents.length, 1, 'content delta should create one message output item');
  assertEquals(addedEvents[0].item.type, 'message');

  const deltaEvents = contentEvents.filter(event => event.type === 'response.output_text.delta');
  assertEquals(deltaEvents.length, 1);
  assertEquals((deltaEvents[0] as { delta: string }).delta, 'hello');
});
