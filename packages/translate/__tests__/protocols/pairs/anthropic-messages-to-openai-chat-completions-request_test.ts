import { test } from 'vitest';

import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { buildTargetPayloadFor, pairs } from '../composition-helpers.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesAssistantContentBlock, AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsFunctionTool } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertFalse, assertRejects } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const buildWithTestSidecar = (payload: AnthropicMessagesPayload) =>
  buildTargetPayloadFor(pairs.messagesToChat[0], pairs.messagesToChat[1], { ...payload, stream: true }, { sidecarCodec: createTestSidecarCodec() });

test('buildTargetPayload maps thinking.disabled to reasoning_effort none', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'none');
});

test('buildTargetPayload prefers output_config.effort over thinking.disabled', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'high');
});

test('buildTargetPayload forwards empty output_config.effort verbatim', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: '' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, '');
});

test('buildTargetPayload maps thinking.enabled to reasoning_effort medium regardless of budget_tokens', async () => {
  for (const budget of [1024, 16384]) {
    const result = await buildWithTestSidecar({
      model: 'gpt-test',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: budget },
      messages: [{ role: 'user', content: 'hi' }],
    });

    assertEquals(result.reasoning_effort, 'medium');
  }
});

test('buildTargetPayload maps thinking.adaptive to reasoning_effort medium', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'medium');
});

test('buildTargetPayload prefers output_config.effort over thinking.enabled', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 4096,
    output_config: { effort: 'high' },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'high');
});

test('buildTargetPayload keeps tool_result and user text as separate chat messages', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }] },
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
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'result' },
    { role: 'user', content: 'Please continue.' },
  ]);
});

test.each([
  { tools: undefined, name: 'lookup' },
  { tools: [{ name: 'other', input_schema: { type: 'object' as const } }], name: 'lookup' },
])('buildTargetPayload rejects named tool_choice for an undeclared tool', async ({ tools, name }) => {
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
      tools,
      tool_choice: { type: 'tool', name },
    }),
    Error,
    `Anthropic Messages tool_choice names an undeclared tool: ${name}`,
  );
});

test('buildTargetPayload drops filtered-native tool_choice and rewrites assistant native web-search history as tool-call history', async () => {
  const result = await buildWithTestSidecar({
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

test('buildTargetPayload folds a server tool result into the client turn that follows it', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'search please' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking' },
          { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'q' } },
          { type: 'web_search_tool_result', tool_use_id: 'st_1', content: [] },
        ],
      },
      { role: 'user', content: 'thanks' },
    ],
  });

  // The result the API wrote into the assistant message and the caller's next
  // message are one client turn in the IR, so they stay one run of messages on
  // the wire instead of being split by an invented boundary.
  assertEquals(result.messages, [
    { role: 'user', content: 'search please' },
    {
      role: 'assistant',
      content: 'looking',
      tool_calls: [{ id: 'st_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"q"}' } }],
    },
    { role: 'tool', tool_call_id: 'st_1', content: '[]' },
    { role: 'user', content: 'thanks' },
  ]);
});

test('buildTargetPayload flattens text-block tool_result content but serializes search-result arrays', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_text', name: 'read_text', input: {} },
          { type: 'tool_use', id: 'toolu_search', name: 'search_docs', input: {} },
        ],
      },
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
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'toolu_text', type: 'function', function: { name: 'read_text', arguments: '{}' } },
        { id: 'toolu_search', type: 'function', function: { name: 'search_docs', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'toolu_text', content: 'hello' },
    {
      role: 'tool',
      tool_call_id: 'toolu_search',
      content: '[{"type":"search_result","source":"https://react.dev","title":"React","content":[{"type":"text","text":"Official docs"}]}]',
    },
  ]);
});

test('buildTargetPayload preserves mixed user/tool_result chronology', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'first_lookup', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'second_lookup', input: {} },
        ],
      },
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
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'first_lookup', arguments: '{}' } },
        { id: 'toolu_2', type: 'function', function: { name: 'second_lookup', arguments: '{}' } },
      ],
    },
    { role: 'user', content: 'First question.' },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'first' },
    { role: 'user', content: 'Follow-up.' },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'second' },
  ]);
});

test('buildTargetPayload concatenates readable thinking groups and drops signatures', async () => {
  const result = await buildWithTestSidecar({
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
    reasoning_text: 'firstsecond',
  } as OpenAIChatCompletionsAssistantMessageEx);
});

test('buildTargetPayload drops redacted opaque blocks while keeping readable thinking', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { signature: '', type: 'thinking', thinking: 'first' },
          { type: 'redacted_thinking', data: 'opaque_later' },
        ],
      },
    ],
  });

  assertEquals(result.messages[0], {
    role: 'assistant',
    content: null,
    reasoning_text: 'first',
  } as OpenAIChatCompletionsAssistantMessageEx);
});

// OpenAI strict-mode JSON Schema validators reject {type: 'object'} without a
// `properties` field. Anthropic accepts that shape, so the input_schema must
// be normalized before forwarding. The reverse direction in
// `translate/src/protocols/openai-chat-completions/as-source/input-to.ts` already
// defaults `parameters` to {type: 'object', properties: {}}. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
test('buildTargetPayload defaults missing input_schema.properties to {} for object tools', async () => {
  const result = await buildWithTestSidecar({
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

test('buildTargetPayload preserves declared input_schema.properties verbatim', async () => {
  const result = await buildWithTestSidecar({
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

  assertEquals((result.tools?.[0] as OpenAIChatCompletionsFunctionTool).function.parameters, {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  });
});

test('buildTargetPayload does not inject properties for non-object input_schema', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [{ name: 'scalar', input_schema: { type: 'string' } }] as unknown as AnthropicMessagesPayload['tools'],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals((result.tools?.[0] as OpenAIChatCompletionsFunctionTool).function.parameters, { type: 'string' });
});

test('buildTargetPayload wraps output_config.format json_schema as response_format with nested json_schema and strict', async () => {
  const schema = {
    type: 'object',
    properties: { test: { type: 'string' } },
    required: ['test'],
    additionalProperties: false,
  };
  const result = await buildWithTestSidecar({
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

test('buildTargetPayload omits response_format when output_config has no format', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { effort: 'high' },
  });

  assertFalse('response_format' in result);
});

test('buildTargetPayload rejects an unknown assistant content block type', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'assistant', content: [{ type: 'audio' } as unknown as AnthropicMessagesAssistantContentBlock] }],
      }),
    Error,
    "messages.0.content.0.type: 'audio' assistant content blocks are not supported",
  );
});

test('buildTargetPayload rejects an unknown user content block type', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'audio' } as unknown as AnthropicMessagesUserContentBlock] }],
      }),
    Error,
    "messages.0.content.0.type: 'audio' content blocks are not supported",
  );
});

test('buildTargetPayload emits in-array role:"system" inline as a CC system message', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'who are you' },
    ],
  });

  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[0].role, 'user');
  assertEquals(result.messages[1], { role: 'system', content: 'be terse' });
  assertEquals(result.messages[2].role, 'user');
});

test('buildTargetPayload preserves in-array system text blocks as separate content parts', async () => {
  const result = await buildWithTestSidecar({
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
  });

  assertEquals(result.messages[0], {
    role: 'system',
    content: [
      { type: 'text', text: 'Para A' },
      { type: 'text', text: 'Para B' },
    ],
  });
});

test('buildTargetPayload preserves top-level system text blocks as separate content parts', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'instructions' },
      { type: 'text', text: 'extra context' },
    ],
    messages: [
      { role: 'user', content: 'hi' },
    ],
  });

  assertEquals(result.messages[0], {
    role: 'system',
    content: [
      { type: 'text', text: 'instructions' },
      { type: 'text', text: 'extra context' },
    ],
  });
});

test('buildTargetPayload skips system message when top-level system is empty array', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    system: [],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, 'user');
});

test('buildTargetPayload preserves chronology of multiple in-array system messages', async () => {
  const result = await buildWithTestSidecar({
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
  });

  // The top-level system comes first (canonical placement), then the
  // in-array sequence is preserved verbatim.
  assertEquals(result.messages[0], { role: 'system', content: 'top-level prompt' });
  assertEquals(result.messages[1], { role: 'system', content: 'mid-array A' });
  assertEquals(result.messages[2].role, 'user');
  assertEquals(result.messages[3].role, 'assistant');
  assertEquals(result.messages[4], { role: 'system', content: 'mid-array B' });
  assertEquals(result.messages[5].role, 'user');
});

test('buildTargetPayload rejects an unknown message role', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'tool', content: 'oops' } as unknown as { role: 'user'; content: string }],
      }),
    Error,
    "messages.0.role: role 'tool' is not supported",
  );
});

// ── speed ↔ service_tier bridge ──

test('buildTargetPayload maps speed:fast to service_tier:fast on the outbound OpenAI Chat Completions payload', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    speed: 'fast',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'priority');
});

test('buildTargetPayload omits service_tier when speed is absent', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('service_tier' in result);
});

test('buildTargetPayload drops speed values other than fast without emitting service_tier', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    speed: 'standard',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('service_tier' in result);
});

test('buildTargetPayload forwards Anthropic service_tier to OpenAI Chat Completions when speed is absent', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'auto');
});

test('buildTargetPayload forwards service_tier:standard_only to OpenAI Chat Completions when speed is absent', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'standard_only',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'standard_only');
});

test('buildTargetPayload asks upstream for continuous streaming usage stats', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });

  assertEquals(result.stream, true);
  assertEquals(result.stream_options, { include_usage: true, continuous_usage_stats: true });
});

test('rejects a metadata value the neutral model cannot state as a string pair', async () => {
  // Messages admits any JSON value as a tag while every metadata-carrying
  // target states string pairs, so a value with no string spelling fails at the
  // reader rather than being dropped or coerced on the way to a target.
  await assertRejects(
    () => buildWithTestSidecar({
      model: 'gpt-test',
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: 'u', nested: { depth: 1 } } as never,
    }),
    TranslatorInputError,
    'nested',
  );
});

test('buildTargetPayload encodes a plain-text document source as base64', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello world' } }],
    }],
  });
  const part = result.messages[0].content;
  if (!Array.isArray(part)) throw new Error('expected a content array');
  assertEquals(part[0], { type: 'file', file: { file_data: 'data:text/plain;base64,aGVsbG8gd29ybGQ=' } });
});
