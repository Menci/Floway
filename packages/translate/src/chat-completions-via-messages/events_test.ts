import { test } from 'vitest';

import { createMessagesToChatCompletionsStreamState, translateMessagesEventToChatCompletionsChunks } from './events.ts';
import { assertEquals } from '../test-assert.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsDelta } from '@floway-dev/protocols/chat-completions';
import { USAGE_BILLING } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

// ── Helpers ──

function process(events: MessagesStreamEvent[]): (ChatCompletionsStreamEvent[] | 'DONE')[] {
  const state = createMessagesToChatCompletionsStreamState();
  return events.map(e => translateMessagesEventToChatCompletionsChunks(e, state));
}

function processFlat(events: MessagesStreamEvent[]): ChatCompletionsStreamEvent[] {
  const results = process(events);
  const chunks: ChatCompletionsStreamEvent[] = [];
  for (const r of results) {
    if (r === 'DONE') break;
    chunks.push(...r);
  }
  return chunks;
}

function deltas(events: MessagesStreamEvent[]): ChatCompletionsDelta[] {
  return processFlat(events)
    .filter(c => c.choices.length > 0)
    .map(c => c.choices[0].delta);
}

const MSG_START: MessagesStreamEvent = {
  type: 'message_start',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-sonnet-4-20250514',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

// ── createMessagesToChatCompletionsStreamState ──

test('initial state has correct defaults', () => {
  const state = createMessagesToChatCompletionsStreamState();
  assertEquals(state.messageId, '');
  assertEquals(state.model, '');
  assertEquals(state.nextToolCallIndex, 0);
  assertEquals(state.usage, { output_tokens: 0 });
  assertEquals(typeof state.created, 'number');
});

// ── message_start ──

test('message_start → chunk with role:assistant', () => {
  const state = createMessagesToChatCompletionsStreamState();
  const result = translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  assertEquals(result !== 'DONE', true);
  const chunks = result as ChatCompletionsStreamEvent[];
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].choices[0].delta.role, 'assistant');
  assertEquals(chunks[0].id, 'msg_test');
  assertEquals(chunks[0].model, 'claude-sonnet-4-20250514');
  assertEquals(chunks[0].object, 'chat.completion.chunk');
});

test('message_start sets state including usage', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  assertEquals(state.messageId, 'msg_test');
  assertEquals(state.model, 'claude-sonnet-4-20250514');
  assertEquals(state.usage.input_tokens, 10);
  assertEquals(state.usage.cache_read_input_tokens, undefined);
});

test('message_start captures cache_read_input_tokens', () => {
  const state = createMessagesToChatCompletionsStreamState();
  const msgStart = MSG_START as {
    type: 'message_start';
    message: Record<string, unknown>;
  };
  translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_start',
      message: {
        ...msgStart.message,
        usage: {
          input_tokens: 80,
          output_tokens: 0,
          cache_read_input_tokens: 20,
        },
      },
    } as MessagesStreamEvent,
    state,
  );
  assertEquals(state.usage.input_tokens, 80);
  assertEquals(state.usage.cache_read_input_tokens, 20);
});

// ── content_block_start: text ──

test('text content_block_start → no output', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    state,
  );
  assertEquals(result, []);
});

// ── content_block_start: thinking ──

test('thinking content_block_start → no output', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    state,
  );
  assertEquals(result, []);
});

// ── content_block_start: redacted_thinking ──

test('redacted_thinking content_block_start → reasoning_opaque chunk', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_xyz' },
    },
    state,
  );
  const chunks = result as ChatCompletionsStreamEvent[];
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].choices[0].delta.reasoning_opaque, 'opaque_xyz');
});

// ── content_block_start: tool_use ──

test('tool_use content_block_start → tool_calls init chunk', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
    },
    state,
  );
  const chunks = result as ChatCompletionsStreamEvent[];
  assertEquals(chunks.length, 1);
  const tc = chunks[0].choices[0].delta.tool_calls;
  assertEquals(tc!.length, 1);
  assertEquals(tc![0].index, 0);
  assertEquals(tc![0].id, 'tu_1');
  assertEquals(tc![0].type, 'function');
  assertEquals(tc![0].function!.name, 'search');
  assertEquals(tc![0].function!.arguments, '');
});

test('multiple tool_use blocks increment index', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);

  translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'f1', input: {} },
    },
    state,
  );

  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_2', name: 'f2', input: {} },
    },
    state,
  );

  const tc = (result as ChatCompletionsStreamEvent[])[0].choices[0].delta.tool_calls;
  assertEquals(tc![0].index, 1);
  assertEquals(tc![0].id, 'tu_2');
  assertEquals(tc![0].function!.name, 'f2');
});

// ── content_block_delta: text_delta ──

test('text_delta → content delta', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    },
  ]);
  // d[0] = role chunk, d[1] = content chunk
  assertEquals(d[1].content, 'Hello');
});

test('multiple text_deltas → multiple content chunks', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
    },
  ]);
  assertEquals(d[1].content, 'Hello');
  assertEquals(d[2].content, ' world');
});

// ── content_block_delta: thinking_delta ──

test('thinking_delta → reasoning_text delta', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me think...' },
    },
  ]);
  assertEquals(d[1].reasoning_text, 'Let me think...');
});

// ── content_block_delta: signature_delta ──

test('signature_delta → reasoning_opaque delta', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'thoughts' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_abc' },
    },
  ]);
  assertEquals(d[2].reasoning_opaque, 'sig_abc');
});

// ── content_block_delta: input_json_delta ──

test('input_json_delta → tool_calls arguments delta', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'f', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"ke' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'y":"val"}' },
    },
  ]);
  // d[0] = role, d[1] = tool init, d[2] = first json delta, d[3] = second json delta
  assertEquals(d[2].tool_calls![0].index, 0);
  assertEquals(d[2].tool_calls![0].function!.arguments, '{"ke');
  assertEquals(d[3].tool_calls![0].function!.arguments, 'y":"val"}');
});

// ── content_block_stop ──

test('content_block_stop → no output, resets block type', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    state,
  );

  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'content_block_stop',
      index: 0,
    },
    state,
  );
  assertEquals(result, []);
});

// ── message_delta ──

test('message_delta with end_turn emits finish chunk plus usage-only chunk', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state); // input_tokens: 10
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 50 },
    },
    state,
  );
  const chunks = result as ChatCompletionsStreamEvent[];
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0].choices[0].finish_reason, 'stop');
  assertEquals(chunks[0].usage, undefined);
  assertEquals(chunks[1].choices, []);
  assertEquals(chunks[1].usage!.prompt_tokens, 10);
  assertEquals(chunks[1].usage!.completion_tokens, 50);
  assertEquals(chunks[1].usage!.total_tokens, 60);
  assertEquals(chunks[1].usage!.prompt_tokens_details, undefined);
});

test('message_delta with tool_use → finish_reason tool_calls', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    },
    state,
  );
  assertEquals((result as ChatCompletionsStreamEvent[])[0].choices[0].finish_reason, 'tool_calls');
});

test('message_delta with max_tokens → finish_reason length', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
    },
    state,
  );
  assertEquals((result as ChatCompletionsStreamEvent[])[0].choices[0].finish_reason, 'length');
});

test('message_delta with stop_sequence → finish_reason stop', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'stop_sequence' },
    },
    state,
  );
  assertEquals((result as ChatCompletionsStreamEvent[])[0].choices[0].finish_reason, 'stop');
});

test('message_delta with pause_turn → finish_reason stop', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'pause_turn' },
    },
    state,
  );
  assertEquals((result as ChatCompletionsStreamEvent[])[0].choices[0].finish_reason, 'stop');
});

test('message_delta with refusal → finish_reason stop', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'refusal' },
    },
    state,
  );
  assertEquals((result as ChatCompletionsStreamEvent[])[0].choices[0].finish_reason, 'stop');
});

test('message_delta without usage → no usage on chunk', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    },
    state,
  );
  assertEquals((result as ChatCompletionsStreamEvent[])[0].usage, undefined);
});

test('message_delta usage includes cache_read_input_tokens from message_start', () => {
  const state = createMessagesToChatCompletionsStreamState();
  // message_start with cache
  translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_start',
      message: {
        ...(
          MSG_START as {
            type: 'message_start';
            message: Record<string, unknown>;
          }
        ).message,
        usage: {
          input_tokens: 80,
          output_tokens: 0,
          cache_read_input_tokens: 20,
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 50 },
    },
    state,
  );
  const chunk = (result as ChatCompletionsStreamEvent[])[1];
  assertEquals((result as ChatCompletionsStreamEvent[])[0].usage, undefined);
  assertEquals(chunk.choices, []);
  assertEquals(chunk.usage!.prompt_tokens, 100); // 80 + 20
  assertEquals(chunk.usage!.completion_tokens, 50);
  assertEquals(chunk.usage!.total_tokens, 150);
  assertEquals(chunk.usage!.prompt_tokens_details!.cached_tokens, 20);
});

// ── message_stop ──

test('message_stop → DONE', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_stop',
    },
    state,
  );
  assertEquals(result, 'DONE');
});

// ── ping / error ──

test('ping → no output', () => {
  const state = createMessagesToChatCompletionsStreamState();
  const result = translateMessagesEventToChatCompletionsChunks({ type: 'ping' }, state);
  assertEquals(result, []);
});

test('error → no output', () => {
  const state = createMessagesToChatCompletionsStreamState();
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    },
    state,
  );
  assertEquals(result, []);
});

// ── All chunk fields carry correct id/model/created ──

test('all chunks carry message id, model, and created', () => {
  const chunks = processFlat([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);
  for (const chunk of chunks) {
    assertEquals(chunk.id, 'msg_test');
    assertEquals(chunk.model, 'claude-sonnet-4-20250514');
    assertEquals(chunk.object, 'chat.completion.chunk');
    assertEquals(typeof chunk.created, 'number');
  }
});

// ── Full streaming scenarios ──

test('full text stream scenario', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    },
  ]);
  assertEquals(d[0].role, 'assistant');
  assertEquals(d[1].content, 'Hello');
  assertEquals(d[2].content, ' world');
  assertEquals(d.length, 4); // role + 2 text + finish
});

test('full thinking + text stream scenario', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me think' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Answer' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);
  assertEquals(d[0].role, 'assistant');
  assertEquals(d[1].reasoning_text, 'Let me think');
  assertEquals(d[2].reasoning_opaque, 'sig');
  assertEquals(d[3].content, 'Answer');
});

test('full tool_use stream scenario', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Calling tool' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'tu_1',
        name: 'search',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"test"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]);
  assertEquals(d[0].role, 'assistant');
  assertEquals(d[1].content, 'Calling tool');
  // tool init
  assertEquals(d[2].tool_calls![0].index, 0);
  assertEquals(d[2].tool_calls![0].id, 'tu_1');
  assertEquals(d[2].tool_calls![0].function!.name, 'search');
  // tool arguments
  assertEquals(d[3].tool_calls![0].function!.arguments, '{"q":');
  assertEquals(d[4].tool_calls![0].function!.arguments, '"test"}');
});

test('full redacted_thinking + text stream scenario', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_blob' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Response' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);
  assertEquals(d[0].role, 'assistant');
  assertEquals(d[1].reasoning_opaque, 'opaque_blob');
  assertEquals(d[2].content, 'Response');
});

test('later reasoning blocks are ignored for Chat scalar streaming', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'first' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_1' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'second' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'sig_2' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);

  assertEquals(d.map(delta => delta.reasoning_text).filter(Boolean), ['first']);
  assertEquals(d.map(delta => delta.reasoning_opaque).filter(Boolean), ['sig_1']);
});

test('first redacted_thinking block suppresses later readable thinking in Chat scalar streaming', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_first' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'later' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);

  assertEquals(d.map(delta => delta.reasoning_opaque).filter(Boolean), ['opaque_first']);
  assertEquals(d.map(delta => delta.reasoning_text).filter(Boolean), []);
});

test('thinking + tool_use stream (interleaved thinking)', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'I need a tool' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_1' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'calc', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]);
  assertEquals(d[0].role, 'assistant');
  assertEquals(d[1].reasoning_text, 'I need a tool');
  assertEquals(d[2].reasoning_opaque, 'sig_1');
  assertEquals(d[3].tool_calls![0].id, 'tu_1');
  assertEquals(d[4].tool_calls![0].function!.arguments, '{"x":1}');
});

test('multiple tool_use blocks in stream', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'f1', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_2', name: 'f2', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]);
  // d[0]=role, d[1]=tool1 init, d[2]=tool1 args, d[3]=tool2 init, d[4]=tool2 args, d[5]=finish
  assertEquals(d[1].tool_calls![0].index, 0);
  assertEquals(d[1].tool_calls![0].id, 'tu_1');
  assertEquals(d[3].tool_calls![0].index, 1);
  assertEquals(d[3].tool_calls![0].id, 'tu_2');
});

// ── Edge: DONE signal propagation ──

test('events after message_stop are not processed', () => {
  const results = process([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]);
  // Last result should be DONE
  assertEquals(results[results.length - 1], 'DONE');
});

// ── Edge: empty deltas ──

test('empty text_delta produces chunk with empty content', () => {
  const d = deltas([
    MSG_START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '' },
    },
  ]);
  assertEquals(d[1].content, '');
});

// ── cache_creation_input_tokens ──

test('message_start captures cache_creation_input_tokens', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_start',
      message: {
        ...(
          MSG_START as {
            type: 'message_start';
            message: Record<string, unknown>;
          }
        ).message,
        usage: {
          input_tokens: 80,
          output_tokens: 0,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
        },
      },
    } as MessagesStreamEvent,
    state,
  );
  assertEquals(state.usage.input_tokens, 80);
  assertEquals(state.usage.cache_read_input_tokens, 20);
  assertEquals(state.usage.cache_creation_input_tokens, 30);
});

test('message_delta usage includes cache_creation_input_tokens in prompt_tokens', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_start',
      message: {
        ...(
          MSG_START as {
            type: 'message_start';
            message: Record<string, unknown>;
          }
        ).message,
        usage: {
          input_tokens: 80,
          output_tokens: 0,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
        },
      },
    } as MessagesStreamEvent,
    state,
  );

  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 50 },
    },
    state,
  );
  const chunk = (result as ChatCompletionsStreamEvent[])[1];
  assertEquals((result as ChatCompletionsStreamEvent[])[0].usage, undefined);
  assertEquals(chunk.choices, []);
  assertEquals(chunk.usage!.prompt_tokens, 130); // 80 + 20 + 30
  assertEquals(chunk.usage!.completion_tokens, 50);
  assertEquals(chunk.usage!.total_tokens, 180);
  assertEquals(chunk.usage!.prompt_tokens_details, { cached_tokens: 20, cache_creation_input_tokens: 30 });
});

// ── speed / service_tier pass-through ──

test('Anthropic speed:fast maps to service_tier:fast on the usage chunk', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);

  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5, speed: 'fast' },
    } as MessagesStreamEvent,
    state,
  ) as ChatCompletionsStreamEvent[];

  const usageChunk = result[1];
  assertEquals(usageChunk.service_tier, 'fast');
});

test('Anthropic service_tier:standard with no speed passes service_tier:standard through on the usage chunk', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);

  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5, service_tier: 'standard' },
    } as MessagesStreamEvent,
    state,
  ) as ChatCompletionsStreamEvent[];

  const usageChunk = result[1];
  assertEquals(usageChunk.service_tier, 'standard');
});

test('no speed or service_tier on message_delta → no service_tier on usage chunk', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(MSG_START, state);

  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    } as MessagesStreamEvent,
    state,
  ) as ChatCompletionsStreamEvent[];

  const usageChunk = result[1];
  assertEquals(usageChunk.service_tier, undefined);
});

test('message_start service_tier survives when message_delta omits it', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(
    {
      ...MSG_START,
      message: {
        ...MSG_START.message,
        usage: { ...MSG_START.message.usage, service_tier: 'priority' },
      },
    },
    state,
  );
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    } as MessagesStreamEvent,
    state,
  ) as ChatCompletionsStreamEvent[];
  assertEquals(result[1].service_tier, 'priority');
});

test('message_delta atomically replaces tier and merges late cache accounting', () => {
  const state = createMessagesToChatCompletionsStreamState();
  translateMessagesEventToChatCompletionsChunks(
    {
      ...MSG_START,
      message: {
        ...MSG_START.message,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 9, speed: 'fast' },
      },
    },
    state,
  );
  const result = translateMessagesEventToChatCompletionsChunks(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 11,
        output_tokens: 2,
        cache_creation: { ephemeral_1h_input_tokens: 5 },
        service_tier: 'priority',
      },
    } as MessagesStreamEvent,
    state,
  ) as ChatCompletionsStreamEvent[];
  assertEquals(result[1].service_tier, 'priority');
  assertEquals(result[1].usage, {
    prompt_tokens: 20,
    completion_tokens: 2,
    total_tokens: 22,
    prompt_tokens_details: { cache_creation_input_tokens: 9 },
    [USAGE_BILLING]: { cacheWrite1hTokenCount: 5 },
  });
});
