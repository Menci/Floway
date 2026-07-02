import { test } from 'vitest';

import { translateResponsesToChatCompletions } from './request.ts';
import { createResponsesToChatCompletionsStreamState, translateResponsesEventToChatCompletionsChunks } from '../chat-completions-via-responses/events.ts';
import { assertEquals, assertThrows } from '../test-assert.ts';
import type { ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

test('translateResponsesToChatCompletions merges adjacent assistant reasoning text and tool calls', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'Hi' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'trace' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '42',
      },
    ],
    instructions: 'system prompt',
    temperature: 0.7,
    top_p: 0.8,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: { trace_id: 'trace_123' },
    stream: false,
    store: false,
    parallel_tool_calls: true,
    text: {
      format: {
        type: 'json_schema',
        name: 'shape',
        strict: true,
        schema: { type: 'object' },
      },
    },
    prompt_cache_key: 'cache-key',
    safety_identifier: 'safe-id',
    reasoning: { effort: 'medium' },
  });

  assertEquals(result.target.model, 'gpt-test');
  assertEquals(result.target.max_tokens, 256);
  assertEquals(result.target.metadata, { trace_id: 'trace_123' });
  assertEquals(result.target.store, false);
  assertEquals(result.target.parallel_tool_calls, true);
  assertEquals(result.target.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'shape',
      strict: true,
      schema: { type: 'object' },
    },
  });
  assertEquals(result.target.prompt_cache_key, 'cache-key');
  assertEquals(result.target.safety_identifier, 'safe-id');
  assertEquals(result.target.reasoning_effort, 'medium');
  assertEquals(result.target.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'Hi' },
    {
      role: 'assistant',
      content: 'Hello',
      reasoning_text: 'trace',
      reasoning_items: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      ],
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: '{"q":"x"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '42',
    },
  ]);
});

test('translateResponsesToChatCompletions preserves all reasoning items and projects only the first scalar group', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'first' }],
      },
      {
        type: 'reasoning',
        id: 'rs_2',
        summary: [{ type: 'summary_text', text: 'second' }],
      },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
  });

  assertEquals(result.target.messages, [
    {
      role: 'assistant',
      content: null,
      reasoning_text: 'first',
      reasoning_items: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'first' }],
        },
        {
          type: 'reasoning',
          id: 'rs_2',
          summary: [{ type: 'summary_text', text: 'second' }],
        },
      ],
    },
  ]);
});

test('translateResponsesToChatCompletions preserves explicit null prompt cache and safety fields', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: 'hello',
    prompt_cache_key: null,
    safety_identifier: null,
  });

  assertEquals('prompt_cache_key' in result.target, true);
  assertEquals(result.target.prompt_cache_key, null);
  assertEquals('safety_identifier' in result.target, true);
  assertEquals(result.target.safety_identifier, null);
});

test('translateResponsesToChatCompletions omits response_format when Responses text.format is absent', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: 'Hi',
    text: {},
  });

  assertEquals('response_format' in result.target, false);
});

test('translateResponsesToChatCompletions preserves explicit null text format', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: 'Hi',
    text: null,
  });

  assertEquals(result.target.response_format, null);
});

test('translateResponsesToChatCompletions reshapes flat json_schema text format into Chat Completions shape', () => {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  };
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: 'Hi',
    text: {
      format: {
        type: 'json_schema',
        name: 'review_output',
        strict: true,
        schema,
      },
    },
  });

  assertEquals(result.target.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'review_output',
      strict: true,
      schema,
    },
  });
});

test('translateResponsesToChatCompletions passes through plain text format without wrapping', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: 'Hi',
    text: { format: { type: 'text' } },
  });

  assertEquals(result.target.response_format, { type: 'text' });
});

test('translateResponsesToChatCompletions does not double-wrap an already-wrapped json_schema', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: 'Hi',
    text: {
      format: {
        type: 'json_schema',
        json_schema: { name: 'already', strict: false, schema: {} },
      },
    },
  });

  assertEquals(result.target.response_format, {
    type: 'json_schema',
    json_schema: { name: 'already', strict: false, schema: {} },
  });
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
              role: 'assistant',
              content: [{ type: 'output_text', text: 'answer' }],
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
              role: 'assistant',
              content: [{ type: 'output_text', text: 'answer' }],
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

test('translateResponsesToChatCompletions filters out builtin tools that have no Chat Completions equivalent', () => {
  // Responses exposes server-side builtin tools (web_search_preview,
  // file_search, image_generation, ...) that have no Chat Completions
  // analogue and no `name` field. These should be filtered out rather than
  // emitting `function: {}` which strict upstreams (vLLM) reject.
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: [
      // Builtin tools — no name, should be dropped
      { type: 'web_search_preview' } as unknown as ResponsesTool,
      { type: 'file_search' } as unknown as ResponsesTool,
      { type: 'image_generation' } as unknown as ResponsesTool,
      { type: 'local_shell' } as unknown as ResponsesTool,
      // Normal function tool — should be kept
      {
        type: 'function' as const,
        name: 'get_weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
        strict: false,
        description: 'Get weather for a city',
      },
      // Another function tool — should be kept
      {
        type: 'function' as const,
        name: 'lookup',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        strict: true,
      },
    ],
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  // Only the two function tools should survive.
  assertEquals(result.target.tools?.length, 2);
  assertEquals(result.target.tools![0].function.name, 'get_weather');
  assertEquals(result.target.tools![0].function.strict, false);
  assertEquals(result.target.tools![0].function.description, 'Get weather for a city');
  assertEquals(result.target.tools![1].function.name, 'lookup');
  assertEquals(result.target.tools![1].function.strict, true);
  assertEquals(result.target.tools![1].function.description, undefined);
});

test('translateResponsesToChatCompletions returns undefined tools when only builtin tools are present', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: [{ type: 'web_search_preview' } as unknown as ResponsesTool, { type: 'image_generation' } as unknown as ResponsesTool],
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(result.target.tools, undefined);
});

test('translateResponsesToChatCompletions drops forced builtin tool_choice but keeps function tool_choice', () => {
  // Forced builtin tool choices have no Chat Completions analogue;
  // they should be dropped (falling back to auto/default).
  const resultWithBuiltinChoice = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: {
      type: 'web_search_preview',
    } as unknown as ResponsesToolChoice,
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(resultWithBuiltinChoice.target.tool_choice, undefined);

  // Forced function tool_choice should be preserved.
  const resultWithFunctionChoice = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: {
      type: 'function' as const,
      name: 'get_weather',
    },
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(resultWithFunctionChoice.target.tool_choice, {
    type: 'function',
    function: { name: 'get_weather' },
  });
});

test('translateResponsesToChatCompletions returns undefined tool_choice for string auto/required/none choices', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: 'auto' as ResponsesToolChoice,
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(result.target.tool_choice, 'auto');
});

test('translateResponsesToChatCompletions wraps custom tools as single-string function tools and records their names', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: 'hi',
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'apply a patch',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: "ok"' },
      },
    ],
    tool_choice: { type: 'custom' as const, name: 'apply_patch' },
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  assertEquals(result.customToolNames.has('apply_patch'), true);
  assertEquals(result.target.tools, [
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'apply a patch',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['input'],
          properties: {
            input: {
              type: 'string',
              description: 'Lark grammar: start: "ok"',
            },
          },
        },
        strict: false,
      },
    },
  ]);
  assertEquals(result.target.tool_choice, { type: 'function', function: { name: 'apply_patch' } });
});

test('translateResponsesToChatCompletions projects custom_tool_call history into wrapped tool_calls shape', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'apply this patch' },
      {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: 'ok',
      },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: [{ type: 'custom', name: 'apply_patch' }],
    tool_choice: 'auto' as ResponsesToolChoice,
    metadata: null,
    stream: null,
    store: null,
    parallel_tool_calls: null,
    text: null,
  });

  const assistant = result.target.messages.find(m => m.role === 'assistant');
  if (!assistant) throw new Error('expected assistant message');
  assertEquals(assistant.tool_calls?.[0], {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'apply_patch',
      arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
    },
  });

  const tool = result.target.messages.find(m => m.role === 'tool');
  assertEquals(tool, {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'ok',
  });
});

test('translateResponsesToChatCompletions throws on a stray web_search_call input item (shim owns the reverse path)', () => {
  // The Responses web-search shim rewrites web_search_call input items into
  // upstream function_call + function_call_output pairs before this
  // translator runs. Reaching the translator with a raw web_search_call
  // means the shim regressed; the translator surfaces a loud error so the
  // bug is caught rather than silently dropping search context.
  assertThrows(
    () => translateResponsesToChatCompletions({
      model: 'gpt-test',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'web_search_call',
          id: 'ws_x',
          status: 'completed',
          action: { type: 'search', queries: ['q'] },
        },
      ],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: 256,
      tools: null,
      tool_choice: 'auto',
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    }),
    Error,
    "Invalid input item type 'web_search_call'",
  );
});

test('translateResponsesToChatCompletions throws on a stray compaction_trigger input item (compact-shim owns the strip)', () => {
  // The compact-shim is structurally required on non-responses targets and
  // strips compaction_trigger items before reaching this translator.
  // Reaching here with one in input means the shim disengaged; the
  // translator's catch-all guard surfaces the regression.
  assertThrows(
    () => translateResponsesToChatCompletions({
      model: 'gpt-test',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'compaction_trigger' },
      ],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: 256,
      tools: null,
      tool_choice: 'auto',
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    }),
    Error,
    "Invalid input item type 'compaction_trigger'",
  );
});

test('translateResponsesToChatCompletions throws on a stray compaction input item (compact-shim owns the expansion)', () => {
  // The compact-shim expands its own shim-encoded compaction items inline
  // before reaching this translator and round-trips foreign compactions
  // back to the upstream as raw items. Either way the translator should
  // never see one.
  assertThrows(
    () => translateResponsesToChatCompletions({
      model: 'gpt-test',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'compaction', id: 'cmp_x', encrypted_content: 'opaque', created_by: 'compaction_session' },
      ],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: 256,
      tools: null,
      tool_choice: 'auto',
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    }),
    Error,
    "Invalid input item type 'compaction'",
  );
});

test('translateResponsesToChatCompletions maps multimodal function_call_output into a tool message with image content', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}', status: 'completed' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'captured' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'high' },
        ],
      },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: false,
    store: false,
    parallel_tool_calls: true,
  });

  const toolMessage = result.target.messages.find(message => message.role === 'tool');
  assertEquals(toolMessage?.content, [
    { type: 'text', text: 'captured' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } },
  ]);
});

// ── Native field forwarding ──

test('translateResponsesToChatCompletions maps text.verbosity onto verbosity', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    text: { verbosity: 'low' },
  });

  assertEquals(result.target.verbosity, 'low');
});

test('translateResponsesToChatCompletions co-emits reasoning.effort onto reasoning_effort and service_tier verbatim', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'xhigh' },
    service_tier: 'priority',
  });

  assertEquals(result.target.reasoning_effort, 'xhigh');
  assertEquals(result.target.service_tier, 'priority');
});

test('translateResponsesToChatCompletions drops reasoning.summary (Chat has no slot)', () => {
  const result = translateResponsesToChatCompletions({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'medium', summary: 'concise' },
  });

  assertEquals(result.target.reasoning_effort, 'medium');
  assertEquals('reasoning_summary' in result.target, false);
});
