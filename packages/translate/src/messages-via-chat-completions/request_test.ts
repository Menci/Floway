import { test } from 'vitest';

import { translateMessagesToChatCompletions } from './request.ts';
import { assertEquals, assertFalse } from '../test-assert.ts';

test('translateMessagesToChatCompletions maps thinking.disabled to reasoning_effort none', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'none');
});

test('translateMessagesToChatCompletions prefers output_config.effort over thinking.disabled', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'high');
});

test('translateMessagesToChatCompletions treats empty output_config.effort as absent', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: '' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'none');
});

test('translateMessagesToChatCompletions keeps tool_result and user text as separate chat messages', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' },
          { type: 'text', text: 'Please continue.' },
        ],
      },
    ],
  });

  assertEquals(result.messages, [
    { role: 'tool', tool_call_id: 'toolu_1', content: 'result' },
    { role: 'user', content: 'Please continue.' },
  ]);
});

test('translateMessagesToChatCompletions drops filtered-native tool_choice and rewrites assistant native web-search history as tool-call history', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    tool_choice: { type: 'any' },
    tools: [{ type: 'web_search_20260209', name: 'NativeSearch' }],
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'st_1',
            name: 'web_search',
            input: { query: 'React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'st_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://react.dev',
                title: 'React',
                encrypted_content: 'opaque-payload',
              },
            ],
          },
        ],
      },
    ],
  });

  assertEquals(result.tools, undefined);
  assertEquals(result.tool_choice, undefined);
  assertEquals(result.messages, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'st_1',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{"query":"React docs"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'st_1',
      content: '[{"type":"web_search_result","url":"https://react.dev","title":"React","encrypted_content":"opaque-payload"}]',
    },
  ]);
});

test('translateMessagesToChatCompletions flattens text-block tool_result content but serializes search-result arrays', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_text',
            content: [{ type: 'text', text: 'hello' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_search',
            content: [
              {
                type: 'search_result',
                source: 'https://react.dev',
                title: 'React',
                content: [{ type: 'text', text: 'Official docs' }],
              },
            ],
          },
        ],
      },
    ],
  });

  assertEquals(result.messages, [
    { role: 'tool', tool_call_id: 'toolu_text', content: 'hello' },
    {
      role: 'tool',
      tool_call_id: 'toolu_search',
      content: '[{"type":"search_result","source":"https://react.dev","title":"React","content":[{"type":"text","text":"Official docs"}]}]',
    },
  ]);
});

test('translateMessagesToChatCompletions preserves mixed user/tool_result chronology', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First question.' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'first' },
          { type: 'text', text: 'Follow-up.' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'second' },
        ],
      },
    ],
  });

  assertEquals(result.messages, [
    { role: 'user', content: 'First question.' },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'first' },
    { role: 'user', content: 'Follow-up.' },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'second' },
  ]);
});

test('translateMessagesToChatCompletions preserves redacted_thinking as reasoning_opaque', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'opaque_sig' }],
      },
    ],
  });

  assertEquals(result.messages, [
    {
      role: 'assistant',
      content: null,
      reasoning_text: null,
      reasoning_opaque: 'opaque_sig',
    },
  ]);
});

test('translateMessagesToChatCompletions projects only the first scalar reasoning group', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first', signature: 'sig_1' },
          { type: 'thinking', thinking: 'second', signature: 'sig_2' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  });

  assertEquals(result.messages[0], {
    role: 'assistant',
    content: 'answer',
    reasoning_text: 'first',
    reasoning_opaque: 'sig_1',
  });
});

test('translateMessagesToChatCompletions does not pair readable thinking with later redacted opaque data', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first' },
          { type: 'redacted_thinking', data: 'opaque_later' },
        ],
      },
    ],
  });

  assertEquals(result.messages[0], {
    role: 'assistant',
    content: null,
    reasoning_text: 'first',
    reasoning_opaque: null,
  });
});

// OpenAI strict-mode JSON Schema validators reject {type: 'object'} without a
// `properties` field. Anthropic accepts that shape, so the input_schema must
// be normalized before forwarding. The reverse direction at
// packages/translate/src/chat-completions-via-messages/request.ts already
// defaults `parameters` to {type: 'object', properties: {}}. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
test('translateMessagesToChatCompletions defaults missing input_schema.properties to {} for object tools', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [{ name: 'no_args', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.tools, [
    {
      type: 'function',
      function: {
        name: 'no_args',
        description: undefined,
        parameters: { type: 'object', properties: {} },
      },
    },
  ]);
});

test('translateMessagesToChatCompletions preserves declared input_schema.properties verbatim', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [
      {
        name: 'with_args',
        input_schema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.tools?.[0].function.parameters, {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  });
});

test('translateMessagesToChatCompletions does not inject properties for non-object input_schema', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    // Non-object root schemas are unusual but legal upstream; we should not
    // synthesize properties on shapes where it is meaningless.
    tools: [{ name: 'scalar', input_schema: { type: 'string' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.tools?.[0].function.parameters, { type: 'string' });
});

test('translateMessagesToChatCompletions wraps output_config.format json_schema as response_format with nested json_schema and strict', () => {
  const schema = {
    type: 'object',
    properties: { test: { type: 'string' } },
    required: ['test'],
    additionalProperties: false,
  };
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { format: { type: 'json_schema', schema } },
  });

  assertEquals(result.response_format, {
    type: 'json_schema',
    json_schema: { name: 'messages_response', strict: true, schema },
  });
});

test('translateMessagesToChatCompletions omits response_format when output_config has no format', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { effort: 'high' },
  });

  assertFalse('response_format' in result);
});
