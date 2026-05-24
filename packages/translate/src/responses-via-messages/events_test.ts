import { test } from 'vitest';

import { createMessagesToResponsesStreamState, translateMessagesEventToResponsesEvents } from './events.ts';
import { assertEquals } from '../test-assert.ts';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponseStreamEvent } from '@floway-dev/protocols/responses';

type ResponseOutputItemAddedEvent = Extract<ResponseStreamEvent, { type: 'response.output_item.added' }>;

type ResponseOutputItemDoneEvent = Extract<ResponseStreamEvent, { type: 'response.output_item.done' }>;

// ── Helpers ──

function runToCompletion(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): ResponsesResult {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-sonnet-4-20250514');

  translateMessagesEventToResponsesEvents(
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-20250514',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: 0,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        },
      },
    } as MessagesStreamEventData,
    state,
  );

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as MessagesStreamEventData,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    } as MessagesStreamEventData,
    state,
  );
  translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEventData, state);
  translateMessagesEventToResponsesEvents(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: usage.output_tokens },
    } as MessagesStreamEventData,
    state,
  );

  const stopEvents = translateMessagesEventToResponsesEvents({ type: 'message_stop' } as MessagesStreamEventData, state);

  const completed = stopEvents.find(e => e.type === 'response.completed');
  if (completed?.type !== 'response.completed') {
    throw new Error('Expected response.completed event');
  }
  return (
    completed as {
      type: 'response.completed';
      response: ResponsesResult;
    }
  ).response;
}

// ── cache_creation_input_tokens ──

test('includes cache_creation_input_tokens in input_tokens', () => {
  const result = runToCompletion({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
  });

  assertEquals(result.usage!.input_tokens, 150); // 100 + 20 + 30
  assertEquals(result.usage!.output_tokens, 50);
  assertEquals(result.usage!.total_tokens, 200);
  assertEquals(result.usage!.input_tokens_details!.cached_tokens, 20);
});

test('handles cache_creation without cache_read', () => {
  const result = runToCompletion({
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 30,
  });

  assertEquals(result.usage!.input_tokens, 130); // 100 + 0 + 30
  assertEquals(result.usage!.total_tokens, 180);
  assertEquals(result.usage!.input_tokens_details, undefined);
});

test('handles no cache fields (backward compat)', () => {
  const result = runToCompletion({
    input_tokens: 100,
    output_tokens: 50,
  });

  assertEquals(result.usage!.input_tokens, 100);
  assertEquals(result.usage!.total_tokens, 150);
  assertEquals(result.usage!.input_tokens_details, undefined);
});

test('redacted_thinking stream block is dropped for Responses output', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_sig' },
    } as MessagesStreamEventData,
    state,
  );

  translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEventData, state);

  assertEquals(state.completedItems, []);
});

test('packed redacted_thinking stream block is dropped for Responses output', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_sig@rs_88' },
    } as MessagesStreamEventData,
    state,
  );

  translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEventData, state);

  assertEquals(state.completedItems, []);
});

test('thinking stream block ignores signature_delta and keeps readable text', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as MessagesStreamEventData,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    } as MessagesStreamEventData,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'enc_xyz@rs_33' },
    } as MessagesStreamEventData,
    state,
  );
  translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEventData, state);

  assertEquals(state.completedItems, [
    {
      type: 'reasoning',
      id: 'rs_0',
      summary: [{ type: 'summary_text', text: 'trace' }],
    },
  ]);
});

test('thinking stream block start emits a plain reasoning item', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  const events = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as MessagesStreamEventData,
    state,
  );

  const added = events.find(event => event.type === 'response.output_item.added') as ResponseOutputItemAddedEvent | undefined;
  if (added?.type !== 'response.output_item.added') {
    throw new Error('expected response.output_item.added event');
  }
  if (added.item.type !== 'reasoning') {
    throw new Error('expected reasoning item');
  }

  assertEquals(added.item, { type: 'reasoning', id: 'rs_0', summary: [] });
});

test('thinking stream block stop emits a plain reasoning item', () => {
  const state = createMessagesToResponsesStreamState('resp_test', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as MessagesStreamEventData,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    } as MessagesStreamEventData,
    state,
  );
  const events = translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEventData, state);

  const done = events.find(event => event.type === 'response.output_item.done') as ResponseOutputItemDoneEvent | undefined;
  if (done?.type !== 'response.output_item.done') {
    throw new Error('expected response.output_item.done event');
  }
  if (done.item.type !== 'reasoning') {
    throw new Error('expected reasoning item');
  }

  assertEquals(done.item, {
    type: 'reasoning',
    id: 'rs_0',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
});

test('max_tokens stream stop becomes response.incomplete', () => {
  const state = createMessagesToResponsesStreamState('resp_max_tokens', 'claude-test');

  translateMessagesEventToResponsesEvents(
    {
      type: 'message_start',
      message: {
        id: 'msg_max_tokens',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    } as MessagesStreamEventData,
    state,
  );
  translateMessagesEventToResponsesEvents(
    {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 7 },
    } as MessagesStreamEventData,
    state,
  );

  const events = translateMessagesEventToResponsesEvents({ type: 'message_stop' } as MessagesStreamEventData, state);

  assertEquals(
    events.map(event => event.type),
    ['response.incomplete'],
  );
  const incomplete = events[0] as Extract<ResponseStreamEvent, { type: 'response.incomplete' }>;
  if (incomplete.type !== 'response.incomplete') {
    throw new Error('expected response.incomplete');
  }
  assertEquals(incomplete.response.status, 'incomplete');
  assertEquals(incomplete.response.incomplete_details, {
    reason: 'max_output_tokens',
  });
  assertEquals(incomplete.response.usage?.output_tokens, 7);
});

test('unwraps wrapped custom tool calls into custom_tool_call shape', () => {
  const state = createMessagesToResponsesStreamState('resp_ctc', 'claude-test', new Set(['apply_patch']));

  translateMessagesEventToResponsesEvents(
    {
      type: 'message_start',
      message: {
        id: 'msg_ctc',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    } as MessagesStreamEventData,
    state,
  );

  const startEvents = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_ctc', name: 'apply_patch', input: {} },
    } as MessagesStreamEventData,
    state,
  );

  const added = startEvents.find((e): e is ResponseOutputItemAddedEvent => e.type === 'response.output_item.added');
  if (!added) throw new Error('expected output_item.added');
  assertEquals(added.item.type, 'custom_tool_call');
  if (added.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(added.item.name, 'apply_patch');
  assertEquals(added.item.input, '');

  // Wrapped function-tool arguments split across two deltas. The translator
  // buffers without emitting and only surfaces the freeform input at stop time.
  const deltaA = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch' },
    } as MessagesStreamEventData,
    state,
  );
  const deltaB = translateMessagesEventToResponsesEvents(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '\\n*** End Patch"}' },
    } as MessagesStreamEventData,
    state,
  );
  assertEquals(deltaA, []);
  assertEquals(deltaB, []);

  const stopEvents = translateMessagesEventToResponsesEvents({ type: 'content_block_stop', index: 0 } as MessagesStreamEventData, state);

  assertEquals(
    stopEvents.map(e => e.type),
    [
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
    ],
  );

  const inputDelta = stopEvents[0] as Extract<ResponseStreamEvent, { type: 'response.custom_tool_call_input.delta' }>;
  const inputDone = stopEvents[1] as Extract<ResponseStreamEvent, { type: 'response.custom_tool_call_input.done' }>;
  const itemDone = stopEvents[2] as ResponseOutputItemDoneEvent;

  assertEquals(inputDelta.delta, '*** Begin Patch\n*** End Patch');
  assertEquals(inputDone.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.type, 'custom_tool_call');
  if (itemDone.item.type !== 'custom_tool_call') throw new Error('expected custom_tool_call item');
  assertEquals(itemDone.item.input, '*** Begin Patch\n*** End Patch');
  assertEquals(itemDone.item.call_id, 'call_ctc');
});
