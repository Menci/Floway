import { test } from 'vitest';

import { createChatCompletionsToResponsesStreamState, flushChatCompletionsToResponsesEvents, translateChatCompletionsChunkToResponsesEvents, translateToSourceEvents } from './events.ts';
import { assertEquals, assertRejects } from '../test-assert.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ResponseStreamEvent } from '@floway-dev/protocols/responses';

type ResponseCompletedEvent = Extract<ResponseStreamEvent, { type: 'response.completed' }>;

type ResponseIncompleteEvent = Extract<ResponseStreamEvent, { type: 'response.incomplete' }>;

const chunk = (
  delta: ChatCompletionChunk['choices'][0]['delta'],
  finishReason: ChatCompletionChunk['choices'][0]['finish_reason'] = null,
  usage?: ChatCompletionChunk['usage'],
): ChatCompletionChunk => ({
  id: 'chatcmpl_stream_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});

const translate = (chunks: ChatCompletionChunk[]): ResponseStreamEvent[] => {
  const state = createChatCompletionsToResponsesStreamState();
  return [...chunks.flatMap(item => translateChatCompletionsChunkToResponsesEvents(item, state)), ...flushChatCompletionsToResponsesEvents(state)];
};

const sequenceNumbers = (events: ResponseStreamEvent[]): number[] => events.map(event => (event as ResponseStreamEvent & { sequence_number: number }).sequence_number);

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

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

  const argumentDeltas = events.filter(event => event.type === 'response.function_call_arguments.delta') as Extract<ResponseStreamEvent, { type: 'response.function_call_arguments.delta' }>[];
  const completed = events.find(event => event.type === 'response.completed') as ResponseCompletedEvent | undefined;

  assertEquals(
    argumentDeltas.map(event => event.delta),
    ['{"q"', ':"x"}'],
  );
  assertEquals(completed?.response.output, [
    {
      type: 'function_call',
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

  const completed = events.find(event => event.type === 'response.completed') as ResponseCompletedEvent | undefined;

  assertEquals(completed?.response.output, [
    {
      type: 'reasoning',
      id: 'rs_carrier',
      summary: [{ type: 'summary_text', text: 'trace' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
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
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
        reasoning_tokens: 2,
      },
    }),
  ]);

  const incomplete = events.find(event => event.type === 'response.incomplete') as ResponseIncompleteEvent | undefined;

  assertEquals(incomplete?.response.status, 'incomplete');
  assertEquals(incomplete?.response.incomplete_details, {
    reason: 'max_output_tokens',
  });
  assertEquals(incomplete?.response.usage, {
    input_tokens: 4,
    output_tokens: 6,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 1 },
  });
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
    } satisfies ChatCompletionChunk);
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
    } satisfies ChatCompletionChunk,
    state,
  );

  // Only output_item.added should fire; no arguments delta.
  assertEquals(
    startEvents.map(e => e.type),
    ['response.created', 'response.in_progress', 'response.output_item.added'],
  );
  const added = startEvents.find((e): e is Extract<ResponseStreamEvent, { type: 'response.output_item.added' }> => e.type === 'response.output_item.added');
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
    } satisfies ChatCompletionChunk,
    state,
  );
  assertEquals(continueEvents, []);

  const finalEvents = flushChatCompletionsToResponsesEvents(state);
  const types = finalEvents.map(e => e.type);
  assertEquals(types.includes('response.custom_tool_call_input.delta'), true);
  assertEquals(types.includes('response.custom_tool_call_input.done'), true);

  const itemDone = finalEvents.find((e): e is Extract<ResponseStreamEvent, { type: 'response.output_item.done' }> => e.type === 'response.output_item.done');
  if (!itemDone) throw new Error('expected output_item.done');
  assertEquals(itemDone.item.type, 'custom_tool_call');
  if (itemDone.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(itemDone.item.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.call_id, 'call_ctc');
});
