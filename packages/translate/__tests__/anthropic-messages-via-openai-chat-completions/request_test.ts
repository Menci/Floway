import { test } from 'vitest';

import { buildTargetRequest } from '../../src/anthropic-messages-via-openai-chat-completions/request.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesAssistantContentBlock, AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsFunctionTool } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertFalse, assertThrows } from '@floway-dev/test-utils';

test('buildTargetRequest maps thinking.disabled to reasoning_effort none', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.reasoning_effort, 'none');
});

test('buildTargetRequest prefers output_config.effort over thinking.disabled', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.reasoning_effort, 'high');
});

test('buildTargetRequest treats empty output_config.effort as absent', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: '' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.reasoning_effort, 'none');
});

test('buildTargetRequest maps thinking.enabled to reasoning_effort medium regardless of budget_tokens', () => {
  for (const budget of [1024, 16384]) {
    const result = buildTargetRequest({
      model: 'gpt-test',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: budget },
      messages: [{ role: 'user', content: 'hi' }],
    }, new Map());

    assertEquals(result.reasoning_effort, 'medium');
  }
});

test('buildTargetRequest maps thinking.adaptive to reasoning_effort medium', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.reasoning_effort, 'medium');
});

test('buildTargetRequest prefers output_config.effort over thinking.enabled', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 4096,
    output_config: { effort: 'high' },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.reasoning_effort, 'high');
});

test('buildTargetRequest keeps tool_result and user text as separate chat messages', () => {
  const result = buildTargetRequest({
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
  }, new Map());

  assertEquals(result.messages, [
    { role: 'tool', tool_call_id: 'toolu_1', content: 'result' },
    { role: 'user', content: 'Please continue.' },
  ]);
});

test('buildTargetRequest drops filtered-native tool_choice and rewrites assistant native web-search history as tool-call history', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    tool_choice: { type: 'any' },
    tools: [{ type: 'web_search_20260209', name: 'NativeSearch' }],
    messages: [
      {
        role: 'assistant',
        content: [
          {
            caller: { type: 'direct' },
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
  }, new Map());

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

test('buildTargetRequest flattens text-block tool_result content but serializes search-result arrays', () => {
  const result = buildTargetRequest({
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
  }, new Map());

  assertEquals(result.messages, [
    { role: 'tool', tool_call_id: 'toolu_text', content: 'hello' },
    {
      role: 'tool',
      tool_call_id: 'toolu_search',
      content: '[{"type":"search_result","source":"https://react.dev","title":"React","content":[{"type":"text","text":"Official docs"}]}]',
    },
  ]);
});

test('buildTargetRequest preserves mixed user/tool_result chronology', () => {
  const result = buildTargetRequest({
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
  }, new Map());

  assertEquals(result.messages, [
    { role: 'user', content: 'First question.' },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'first' },
    { role: 'user', content: 'Follow-up.' },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'second' },
  ]);
});

test('foreign thinking and redacted blocks are discarded without an accepted carrier', () => {
  const result = buildTargetRequest({
    model: 'm', max_tokens: 1, messages: [
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'foreign' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign', signature: 'foreign' }, { type: 'text', text: 'answer' }] },
    ],
  }, new Map());
  assertEquals(result.messages, [{ role: 'assistant', content: 'answer' }]);
});

// OpenAI strict-mode JSON Schema validators reject {type: 'object'} without a
// `properties` field. Anthropic accepts that shape, so the input_schema must
// be normalized before forwarding. The reverse direction at
// packages/translate/src/openai-chat-completions-via-anthropic-messages/request.ts already
// defaults `parameters` to {type: 'object', properties: {}}. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
test('buildTargetRequest defaults missing input_schema.properties to {} for object tools', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [{ name: 'no_args', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

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

test('buildTargetRequest preserves declared input_schema.properties verbatim', () => {
  const result = buildTargetRequest({
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
  }, new Map());

  assertEquals((result.tools?.[0] as OpenAIChatCompletionsFunctionTool).function.parameters, {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  });
});

test('buildTargetRequest does not inject properties for non-object input_schema', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [{ name: 'scalar', input_schema: { type: 'string' } }] as unknown as AnthropicMessagesPayload['tools'],
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals((result.tools?.[0] as OpenAIChatCompletionsFunctionTool).function.parameters, { type: 'string' });
});

test('buildTargetRequest wraps output_config.format json_schema as response_format with nested json_schema and strict', () => {
  const schema = {
    type: 'object',
    properties: { test: { type: 'string' } },
    required: ['test'],
    additionalProperties: false,
  };
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { format: { type: 'json_schema', schema } },
  }, new Map());

  assertEquals(result.response_format, {
    type: 'json_schema',
    json_schema: { name: 'messages_response', strict: true, schema },
  });
});

test('buildTargetRequest omits response_format when output_config has no format', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { effort: 'high' },
  }, new Map());

  assertFalse('response_format' in result);
});

test('buildTargetRequest rejects an unknown assistant content block type', () => {
  assertThrows(
    () =>
      buildTargetRequest({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'assistant', content: [{ type: 'audio' } as unknown as AnthropicMessagesAssistantContentBlock] }],
      }, new Map()),
    Error,
    "messages.0.content.0.type: 'audio' assistant content blocks are not supported",
  );
});

test('buildTargetRequest rejects an unknown user content block type', () => {
  assertThrows(
    () =>
      buildTargetRequest({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'audio' } as unknown as AnthropicMessagesUserContentBlock] }],
      }, new Map()),
    Error,
    "messages.0.content.0.type: 'audio' content blocks are not supported",
  );
});

test('buildTargetRequest emits in-array role:"system" inline as a CC system message', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'who are you' },
    ],
  }, new Map());

  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[0].role, 'user');
  assertEquals(result.messages[1], { role: 'system', content: 'be terse' });
  assertEquals(result.messages[2].role, 'user');
});

test('buildTargetRequest preserves in-array system text blocks as separate content parts', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Para A' },
          { type: 'text', text: 'Para B' },
        ],
      },
      { role: 'user', content: 'hi' },
    ],
  }, new Map());

  assertEquals(result.messages[0], {
    role: 'system',
    content: [
      { type: 'text', text: 'Para A' },
      { type: 'text', text: 'Para B' },
    ],
  });
});

test('buildTargetRequest preserves top-level system text blocks as separate content parts', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'instructions' },
      { type: 'text', text: 'extra context' },
    ],
    messages: [
      { role: 'user', content: 'hi' },
    ],
  }, new Map());

  assertEquals(result.messages[0], {
    role: 'system',
    content: [
      { type: 'text', text: 'instructions' },
      { type: 'text', text: 'extra context' },
    ],
  });
});

test('buildTargetRequest skips system message when top-level system is empty array', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    system: [],
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, 'user');
});

test('buildTargetRequest preserves chronology of multiple in-array system messages', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    system: 'top-level prompt',
    messages: [
      { role: 'system', content: 'mid-array A' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'mid-array B' },
      { role: 'user', content: 'q2' },
    ],
  }, new Map());

  // The top-level system comes first (canonical placement), then the
  // in-array sequence is preserved verbatim.
  assertEquals(result.messages[0], { role: 'system', content: 'top-level prompt' });
  assertEquals(result.messages[1], { role: 'system', content: 'mid-array A' });
  assertEquals(result.messages[2].role, 'user');
  assertEquals(result.messages[3].role, 'assistant');
  assertEquals(result.messages[4], { role: 'system', content: 'mid-array B' });
  assertEquals(result.messages[5].role, 'user');
});

test('buildTargetRequest rejects an unknown message role', () => {
  assertThrows(
    () =>
      buildTargetRequest({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'tool', content: 'oops' } as unknown as { role: 'user'; content: string }],
      }, new Map()),
    Error,
    "messages.0.role: role 'tool' is not supported",
  );
});

test('buildTargetRequest drops Anthropic-only knobs that have no OpenAI-Chat-Completions slot', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' },
  }, new Map());

  // Only the OpenAI-canonical effort axis survives; budget_tokens and display
  // have no OpenAI-Chat-Completions equivalent and translate emits nothing for
  // them. `speed` has its own bridge test below and is intentionally
  // excluded here.
  assertEquals(result.reasoning_effort, 'medium');
});

// ── speed ↔ service_tier bridge ──

test('buildTargetRequest maps speed:fast to service_tier:fast on the outbound OpenAI Chat Completions payload', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    speed: 'fast',
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.service_tier, 'priority');
});

test('buildTargetRequest omits service_tier when speed is absent', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertFalse('service_tier' in result);
});

test('buildTargetRequest drops speed values other than fast without emitting service_tier', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    speed: 'standard',
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertFalse('service_tier' in result);
});

test('buildTargetRequest forwards Anthropic service_tier to OpenAI Chat Completions when speed is absent', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.service_tier, 'auto');
});

test('buildTargetRequest forwards service_tier:standard_only to OpenAI Chat Completions when speed is absent', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'standard_only',
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.service_tier, 'standard_only');
});

test('buildTargetRequest asks upstream for continuous streaming usage stats', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  }, new Map());

  assertEquals(result.stream, true);
  assertEquals(result.stream_options, { include_usage: true, continuous_usage_stats: true });
});
