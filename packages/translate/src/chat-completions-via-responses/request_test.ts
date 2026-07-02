import { test } from 'vitest';

import { translateChatCompletionsToResponses } from './request.ts';
import { createChatCompletionsToResponsesStreamState, flushChatCompletionsToResponsesEvents, translateChatCompletionsChunkToResponsesEvents } from '../responses-via-chat-completions/events.ts';
import { assertEquals, assertFalse, assertThrows } from '../test-assert.ts';
import type { ChatCompletionsMessage, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ResponsesInputReasoning, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

type ResponsesOutputItemDoneEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;

type ResponsesOutputItemAddedEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;

type ResponsesCompletedEvent = Extract<ResponsesStreamEvent, { type: 'response.completed' }>;

const chunk = (delta: ChatCompletionsStreamEvent['choices'][0]['delta'], finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_stream_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

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

test('translateChatCompletionsToResponses uses rs-prefixed ids for reasoning input items', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_text: 'trace',
        reasoning_opaque: 'enc',
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponsesInputReasoning;
  assertEquals(reasoning.type, 'reasoning');
  assertEquals(reasoning.id, 'rs_0');
});

test('translateChatCompletionsToResponses preserves text-only scalar reasoning', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_text: 'visible trace',
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  assertEquals(result.input[0], {
    type: 'reasoning',
    id: 'rs_0',
    summary: [{ type: 'summary_text', text: 'visible trace' }],
  });
});

test('translateChatCompletionsToResponses prefers reasoning_items over scalar reasoning', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_text: 'legacy trace',
        reasoning_opaque: 'legacy_enc',
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_existing',
            summary: [{ type: 'summary_text', text: 'first' }],
          },
          {
            type: 'reasoning',
            summary: [],
          },
        ],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  assertEquals(result.input.filter(item => item.type === 'reasoning'), [
    {
      type: 'reasoning',
      id: 'rs_existing',
      summary: [{ type: 'summary_text', text: 'first' }],
    },
  ]);
});

test('translateChatCompletionsToResponses rejects tool messages without tool_call_id', () => {
  assertThrows(
    () =>
      translateChatCompletionsToResponses({
        model: 'gpt-test',
        messages: [{ role: 'tool', content: 'result' }],
      }),
    Error,
    'tool_call_id',
  );
});

test('translateChatCompletionsToResponses preserves translated OpenAI request fields', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    response_format: { type: 'json_schema', json_schema: { name: 'shape' } },
    metadata: { trace_id: 'abc' },
    store: true,
    parallel_tool_calls: false,
    reasoning_effort: 'medium',
    prompt_cache_key: 'cache-key',
    safety_identifier: 'safe-id',
  });

  assertEquals(result.text, {
    format: { type: 'json_schema', json_schema: { name: 'shape' } },
  });
  assertEquals(result.metadata, { trace_id: 'abc' });
  assertEquals(result.store, true);
  assertEquals(result.parallel_tool_calls, false);
  assertEquals(result.reasoning, { effort: 'medium' });
  assertEquals(result.prompt_cache_key, 'cache-key');
  assertEquals(result.safety_identifier, 'safe-id');
  assertFalse('include' in result);
});

test('translateChatCompletionsToResponses omits store when Chat omits store', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assertFalse('store' in result);
});

test('translateChatCompletionsToResponses preserves explicit null prompt cache and safety fields', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    prompt_cache_key: null,
    safety_identifier: null,
  });

  assertEquals('prompt_cache_key' in result, true);
  assertEquals(result.prompt_cache_key, null);
  assertEquals('safety_identifier' in result, true);
  assertEquals(result.safety_identifier, null);
});

test('translateChatCompletionsToResponses hoists only the initial contiguous system prefix', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'sys-1' },
      { role: 'system', content: 'sys-2' },
      { role: 'user', content: 'u1' },
      { role: 'developer', content: 'dev-late' },
      { role: 'system', content: 'sys-late' },
      { role: 'assistant', content: 'a1' },
    ],
  });

  assertEquals(result.instructions, 'sys-1\n\nsys-2');
  assertEquals(result.input, [
    { type: 'message', role: 'user', content: 'u1' },
    { type: 'message', role: 'developer', content: 'dev-late' },
    { type: 'message', role: 'system', content: 'sys-late' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'a1' }],
    },
  ]);
});

test('translateChatCompletionsToResponses preserves explicit tool strict and defaults omission to false', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'explicit_strict',
          parameters: { type: 'object' },
          strict: true,
        },
      },
      {
        type: 'function',
        function: {
          name: 'implicit_non_strict',
          parameters: { type: 'object' },
        },
      },
    ],
  });

  assertEquals(result.tools, [
    {
      type: 'function',
      name: 'explicit_strict',
      parameters: { type: 'object' },
      strict: true,
    },
    {
      type: 'function',
      name: 'implicit_non_strict',
      parameters: { type: 'object' },
      strict: false,
    },
  ]);
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
    id: 'rs_0',
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
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
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
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    },
  ]);
});

test('translateChatCompletionsChunkToResponsesEvents ignores empty tool_calls arrays', () => {
  const state = createChatCompletionsToResponsesStreamState();
  // Before the fix, empty tool_calls [] was truthy and entered the
  // tool-calls branch, prematurely closing the text item. After the fix
  // (choice.delta.tool_calls?.length), empty arrays are treated as absent.
  const events1 = translateChatCompletionsChunkToResponsesEvents(chunk({ role: 'assistant', tool_calls: [] }), state);
  // role + empty tool_calls should only emit response.created + response.in_progress.
  // No tool-call events should be emitted.
  assertEquals(events1.length, 2);
  assertEquals(events1[0].type, 'response.created');
  assertEquals(events1[1].type, 'response.in_progress');

  // Content delta should create a message item and emit text delta — not a new
  // output item for empty tool_calls.
  const events2 = translateChatCompletionsChunkToResponsesEvents(chunk({ content: 'hello' }), state);
  const addedEvents = events2.filter(e => e.type === 'response.output_item.added') as ResponsesOutputItemAddedEvent[];
  assertEquals(addedEvents.length, 1, 'content delta should create one message output item');
  assertEquals(addedEvents[0].item.type, 'message');

  const deltaEvents = events2.filter(e => e.type === 'response.output_text.delta');
  assertEquals(deltaEvents.length, 1);
  assertEquals((deltaEvents[0] as { delta: string }).delta, 'hello');
});

test('translateChatCompletionsToResponses rejects an unknown message role', () => {
  assertThrows(
    () =>
      translateChatCompletionsToResponses({
        model: 'gpt-test',
        messages: [{ role: 'function', content: 'hi' } as unknown as ChatCompletionsMessage],
      }),
    Error,
    "Invalid role 'function'",
  );
});

test('translateChatCompletionsToResponses forwards reasoning_effort and service_tier onto the native slots', () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'medium',
    service_tier: 'priority',
  });

  assertEquals(result.reasoning, { effort: 'medium' });
  assertEquals(result.service_tier, 'priority');
});

test("translateChatCompletionsToResponses drops reasoning_effort='none' since Responses has no equivalent", () => {
  const result = translateChatCompletionsToResponses({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  assertEquals(result.reasoning, undefined);
});
