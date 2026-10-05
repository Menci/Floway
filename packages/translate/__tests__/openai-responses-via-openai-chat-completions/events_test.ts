import { expect, test } from 'vitest';

import { createOpenAIChatCompletionsToOpenAIResponsesStreamState, flushOpenAIChatCompletionsToOpenAIResponsesEvents, translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents, translateToSourceEvents } from '../../src/openai-responses-via-openai-chat-completions/events.ts';
import { privateContext } from '../test-utils/assistant-message-private.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsUsageEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

type OpenAIResponsesOutputItemAddedEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.added' }>;

type OpenAIResponsesCompletedEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'response.completed' }>;

type OpenAIResponsesIncompleteEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'response.incomplete' }>;

const chunk = (
  delta: OpenAIChatCompletionsStreamEvent['choices'][0]['delta'],
  finishReason: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null,
  usage?: OpenAIChatCompletionsUsageEx | null,
): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_stream_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});

const translate = (chunks: OpenAIChatCompletionsStreamEvent[]): OpenAIResponsesStreamEventEx[] => {
  const state = createOpenAIChatCompletionsToOpenAIResponsesStreamState();
  return [...chunks.flatMap(item => translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(item, state)), ...flushOpenAIChatCompletionsToOpenAIResponsesEvents(state)];
};

const sequenceNumbers = (events: OpenAIResponsesStreamEventEx[]): number[] => events.map(event => (event as OpenAIResponsesStreamEventEx & { sequence_number: number }).sequence_number);

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents preserves refusal output lifecycle', () => {
  const events = translate([
    chunk({ role: 'assistant', content: null, refusal: '' }),
    chunk({ refusal: 'Cannot ' }),
    chunk({ refusal: 'help.' }),
    chunk({}, 'stop'),
  ]);
  const completed = events.find(event => event.type === 'response.completed') as OpenAIResponsesCompletedEvent | undefined;

  assertEquals(events.filter(event => event.type === 'response.refusal.delta').map(event => (event as Extract<OpenAIResponsesStreamEventEx, { type: 'response.refusal.delta' }>).delta), ['Cannot ', 'help.']);
  assertEquals(completed?.response.output, [{
    type: 'message',
    id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'refusal', refusal: 'Cannot help.' }],
  }]);
  assertEquals(Object.hasOwn(completed!.response, 'output_text'), false);
});

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents preserves an empty refusal item', () => {
  const events = translate([
    chunk({ role: 'assistant', content: null, refusal: '' }),
    chunk({}, 'stop'),
  ]);
  const completed = events.find(event => event.type === 'response.completed') as OpenAIResponsesCompletedEvent | undefined;

  assertEquals(completed?.response.output, [{
    type: 'message',
    id: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'refusal', refusal: '' }],
  }]);
});

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents preserves tool call deltas and terminal output', () => {
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

  const argumentDeltas = events.filter(event => event.type === 'response.function_call_arguments.delta') as Extract<OpenAIResponsesStreamEventEx, { type: 'response.function_call_arguments.delta' }>[];
  const completed = events.find(event => event.type === 'response.completed') as OpenAIResponsesCompletedEvent | undefined;

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

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents maps usage on incomplete length terminal', () => {
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

  const incomplete = events.find(event => event.type === 'response.incomplete') as OpenAIResponsesIncompleteEvent | undefined;

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
] as const)('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents maps OpenAI Chat Completions cache-write detail %o', (promptTokensDetails, expectedWrite) => {
  const events = translate([
    chunk({ role: 'assistant' }),
    chunk({}, 'stop', {
      prompt_tokens: 4,
      completion_tokens: 1,
      total_tokens: 5,
      prompt_tokens_details: promptTokensDetails,
    }),
  ]);
  const completed = events.find(event => event.type === 'response.completed') as OpenAIResponsesCompletedEvent | undefined;
  assertEquals(completed?.response.usage?.input_tokens_details, { cached_tokens: 0, cache_write_tokens: expectedWrite });
});

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents rejects malformed inclusive cache counts', () => {
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

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents preserves response service_tier', () => {
  const terminal = {
    ...chunk({}, 'stop', { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
    service_tier: 'priority',
  } satisfies OpenAIChatCompletionsStreamEvent;
  const events = translate([chunk({ role: 'assistant' }), terminal]);
  const completed = events.find(event => event.type === 'response.completed') as OpenAIResponsesCompletedEvent | undefined;
  assertEquals(completed?.response.service_tier, 'priority');
});

test('translateToSourceEvents accepts OpenAI Chat Completions streams without DONE', async () => {
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
    } satisfies OpenAIChatCompletionsStreamEvent);
  }

  await drain(translateToSourceEvents(stream(), new Set(), privateContext()));
});

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents unwraps wrapped custom tool calls into custom_tool_call shape', () => {
  const state = createOpenAIChatCompletionsToOpenAIResponsesStreamState(new Set(['apply_patch']));

  // Initial chunk announces the tool call name; wrapped tools should not emit
  // an incremental arguments delta even when args bytes already arrived.
  const startEvents = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(
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
    } satisfies OpenAIChatCompletionsStreamEvent,
    state,
  );

  // Only output_item.added should fire; no arguments delta.
  assertEquals(
    startEvents.map(e => e.type),
    ['response.created', 'response.in_progress', 'response.output_item.added'],
  );
  const added = startEvents.find((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.added' }> => e.type === 'response.output_item.added');
  if (!added) throw new Error('expected output_item.added');
  assertEquals(added.item.type, 'custom_tool_call');

  const continueEvents = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(
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
    } satisfies OpenAIChatCompletionsStreamEvent,
    state,
  );
  assertEquals(continueEvents.map(event => event.type), ['response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done', 'response.output_item.done']);

  const finalEvents = [...continueEvents, ...flushOpenAIChatCompletionsToOpenAIResponsesEvents(state)];
  const types = finalEvents.map(e => e.type);
  assertEquals(types.includes('response.custom_tool_call_input.delta'), true);
  assertEquals(types.includes('response.custom_tool_call_input.done'), true);

  const itemDone = finalEvents.find((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }> => e.type === 'response.output_item.done');
  if (!itemDone) throw new Error('expected output_item.done');
  assertEquals(itemDone.item.type, 'custom_tool_call');
  if (itemDone.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(itemDone.item.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.call_id, 'call_ctc');
});

test('translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents ignores empty tool_calls arrays', () => {
  const state = createOpenAIChatCompletionsToOpenAIResponsesStreamState();
  const initialEvents = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk({ role: 'assistant', tool_calls: [] }), state);
  assertEquals(initialEvents.length, 2);
  assertEquals(initialEvents[0].type, 'response.created');
  assertEquals(initialEvents[1].type, 'response.in_progress');

  const contentEvents = translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk({ content: 'hello' }), state);
  const addedEvents = contentEvents.filter(event => event.type === 'response.output_item.added') as OpenAIResponsesOutputItemAddedEvent[];
  assertEquals(addedEvents.length, 1, 'content delta should create one message output item');
  assertEquals(addedEvents[0].item.type, 'message');

  const deltaEvents = contentEvents.filter(event => event.type === 'response.output_text.delta');
  assertEquals(deltaEvents.length, 1);
  assertEquals((deltaEvents[0] as { delta: string }).delta, 'hello');
});
