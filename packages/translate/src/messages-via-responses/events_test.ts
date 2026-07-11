import { test } from 'vitest';

import { createResponsesToMessagesStreamState, translateResponsesStreamEventToMessagesEvents, translateResponsesToMessagesResult } from './events.ts';
import { packReasoningSignature } from '../shared/messages-and-responses/reasoning.ts';
import { assertEquals } from '../test-assert.ts';

test('Responses reasoning stream without readable summary emits a redacted_thinking carrier', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
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
  );

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: packReasoningSignature('rs_0', '') },
    },
  ]);
});

test('text-only Responses reasoning stream emits a recoverable signature delta', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        delta: 'trace',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: packReasoningSignature('rs_0', '') },
    },
  ]);
});

test('Responses reasoning stream keeps summary text from deltas when done summary is empty', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        delta: 'trace',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
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
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: packReasoningSignature('rs_0', '') },
    },
  ]);
});

test('done-only Responses reasoning summary stream emits thinking text once', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        text: 'trace',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      },
      state,
    ),
  ];

  assertEquals(
    events.filter(event => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta'),
    [
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'trace' },
      },
    ],
  );
});

test('done-only Responses reasoning summary stream emits every summary part once', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        text: 'first',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 1,
        text: 'second',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
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
  ];

  assertEquals(
    events.flatMap(event => (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' ? [event.delta.thinking] : [])),
    ['first', 'second'],
  );
});

test('opaque-only Responses reasoning stream releases later text when done', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
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
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: packReasoningSignature('rs_0', '') },
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
      delta: { type: 'text_delta', text: 'answer' },
    },
  ]);
});

test('Responses reasoning stream preserves source order when later reasoning finishes first', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
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
    ...translateResponsesStreamEventToMessagesEvents(
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
  ];

  assertEquals(events, [
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
      delta: { type: 'signature_delta', signature: packReasoningSignature('rs_0', '') },
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
      delta: { type: 'signature_delta', signature: packReasoningSignature('rs_1', '') },
    },
  ]);
});

test('Responses stream keeps later text deferred until earlier tool block is done', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
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
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_0',
        output_index: 0,
        delta: '{"q":',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_0',
        output_index: 0,
        arguments: '{"q":1}',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_0',
          name: 'lookup',
          arguments: '{"q":1}',
          status: 'completed',
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call_0',
        name: 'lookup',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
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
      delta: { type: 'text_delta', text: 'answer' },
    },
  ]);
});

test('reasoning stream with no summary emits a redacted_thinking carrier', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_empty', summary: [] },
    },
    state,
  );

  assertEquals(events, [
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: packReasoningSignature('rs_empty', '') } },
  ]);
});

test('reasoning stream with an opaque-only item carries encrypted_content in the redacted carrier', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
        encrypted_content: 'opaque',
      },
    },
    state,
  );

  assertEquals(events, [
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: packReasoningSignature('rs_undef', 'opaque') } },
  ]);
});

test('reasoning stream with whitespace-only summary emits a redacted_thinking carrier', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_ws',
        summary: [{ type: 'summary_text', text: '   \n  ' }],
      },
    },
    state,
  );

  assertEquals(events, [
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: packReasoningSignature('rs_ws', '') } },
  ]);
});

test('translateResponsesToMessagesResult carries reasoning id in thinking signature', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_123',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'trace' }],
      },
    ],
    output_text: '',
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  });

  const block = result.content[0];
  assertEquals(block, { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_1', '') });
});

test('translateResponsesToMessagesResult projects opaque-only reasoning into redacted_thinking', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_123',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        encrypted_content: 'opaque',
      },
    ],
    output_text: '',
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  });

  assertEquals(result.content, [{ type: 'redacted_thinking', data: packReasoningSignature('rs_1', 'opaque') }]);
});

test('translateResponsesToMessagesResult round-trips an id-only reasoning as packed redacted_thinking', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_drop',
    object: 'response',
    model: 'gpt-test',
    output: [
      { type: 'reasoning', id: 'rs_empty', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    ],
    output_text: 'hello',
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  });

  assertEquals(result.content, [
    { type: 'redacted_thinking', data: packReasoningSignature('rs_empty', '') },
    { type: 'text', text: 'hello' },
  ]);
});

test('translateResponsesToMessagesResult round-trips an id-only reasoning with no readable summary', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_undef',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
      },
    ],
    output_text: '',
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  });

  assertEquals(result.content, [{ type: 'redacted_thinking', data: packReasoningSignature('rs_undef', '') }]);
});

test('translateResponsesToMessagesResult projects whitespace-only reasoning summary as packed redacted_thinking', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_ws',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_ws',
        summary: [{ type: 'summary_text', text: '   \n  ' }],
      },
    ],
    output_text: '',
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  });

  assertEquals(result.content, [{ type: 'redacted_thinking', data: packReasoningSignature('rs_ws', '') }]);
});

test('translateResponsesToMessagesResult maps service_tier:fast to usage.speed:fast', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_fast',
    object: 'response',
    model: 'gpt-test',
    output: [],
    output_text: '',
    status: 'completed',
    error: null,
    incomplete_details: null,
    service_tier: 'fast',
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });

  assertEquals(result.usage.speed, 'fast');
});

test('translateResponsesToMessagesResult omits usage.speed when service_tier is not fast', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_default',
    object: 'response',
    model: 'gpt-test',
    output: [],
    output_text: '',
    status: 'completed',
    error: null,
    incomplete_details: null,
    service_tier: 'default',
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });

  assertEquals(result.usage.speed, undefined);
});

test('translateResponsesToMessagesResult omits usage.speed when service_tier is absent', () => {
  const result = translateResponsesToMessagesResult({
    id: 'resp_no_tier',
    object: 'response',
    model: 'gpt-test',
    output: [],
    output_text: '',
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });

  assertEquals(result.usage.speed, undefined);
});

const responseFailedEvent = (error: { code: string; message: string }): Parameters<typeof translateResponsesStreamEventToMessagesEvents>[0] => ({
  type: 'response.failed',
  response: {
    id: 'resp_ctx',
    object: 'response',
    model: 'gpt-test',
    output: [],
    output_text: '',
    status: 'failed',
    error,
    incomplete_details: null,
    usage: undefined,
  },
});

test('Codex-shaped response.failed with context_length_exceeded → invalid_request_error with prompt-too-long prefix', () => {
  const state = createResponsesToMessagesStreamState();
  const events = translateResponsesStreamEventToMessagesEvents(
    responseFailedEvent({ code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' }),
    state,
  );

  assertEquals(events, [{
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.',
    },
  }]);
});

test('Copilot-shaped response.failed with model_max_prompt_tokens_exceeded → invalid_request_error with prompt-too-long prefix', () => {
  const state = createResponsesToMessagesStreamState();
  const events = translateResponsesStreamEventToMessagesEvents(
    responseFailedEvent({ code: 'model_max_prompt_tokens_exceeded', message: 'prompt token count of 1000000 exceeds the limit of 128000' }),
    state,
  );

  assertEquals(events, [{
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.',
    },
  }]);
});

test('response.failed with an unrelated code passes through as api_error carrying the upstream message', () => {
  const state = createResponsesToMessagesStreamState();
  const events = translateResponsesStreamEventToMessagesEvents(
    responseFailedEvent({ code: 'server_error', message: 'upstream failed' }),
    state,
  );

  assertEquals(events, [{
    type: 'error',
    error: { type: 'api_error', message: 'upstream failed' },
  }]);
});

test('stream `error` event with context_length_exceeded code → invalid_request_error with prompt-too-long prefix', () => {
  const state = createResponsesToMessagesStreamState();
  const events = translateResponsesStreamEventToMessagesEvents(
    { type: 'error', code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' },
    state,
  );

  assertEquals(events, [{
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.',
    },
  }]);
});

test('stream `error` event without a matching code but with a matching message substring → invalid_request_error', () => {
  const state = createResponsesToMessagesStreamState();
  const events = translateResponsesStreamEventToMessagesEvents(
    { type: 'error', message: "This model's maximum context length is 4097 tokens. However, your messages resulted in 4498 tokens." },
    state,
  );

  assertEquals(events, [{
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.',
    },
  }]);
});

test('stream `error` event with a mundane message → api_error carrying that message', () => {
  const state = createResponsesToMessagesStreamState();
  const events = translateResponsesStreamEventToMessagesEvents(
    { type: 'error', message: 'transient upstream hiccup' },
    state,
  );

  assertEquals(events, [{
    type: 'error',
    error: { type: 'api_error', message: 'transient upstream hiccup' },
  }]);
});
