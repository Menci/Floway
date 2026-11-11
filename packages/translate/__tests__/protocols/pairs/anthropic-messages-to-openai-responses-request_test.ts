import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesAssistantContentBlock, AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesFunctionTool, OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertFalse, assertRejects } from '@floway-dev/test-utils';

const buildWithTestSidecar = (payload: AnthropicMessagesPayload) =>
  buildTargetPayloadFor(pairs.messagesToResponses[0], pairs.messagesToResponses[1], { ...payload, stream: true }, { sidecarCodec: createTestSidecarCodec() });

test('keeps search result runs between the text and images around them', async () => {
  const first = { type: 'search_result' as const, source: 'https://example.com/1', title: 'First', content: [{ type: 'text' as const, text: 'one' }] };
  const second = { ...first, source: 'https://example.com/2', title: 'Second' };
  const third = { ...first, source: 'https://example.com/3', title: 'Third' };
  const result = await buildWithTestSidecar({
    model: 'model', max_tokens: 32, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'lookup', input: {} }] },
      {
        role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'c', content: [
            { type: 'text', text: 'Before' }, first, second,
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            third, { type: 'text', text: 'After' },
          ],
        }],
      },
    ],
  });
  assertEquals(result.input[1], {
    type: 'function_call_output', call_id: 'c', status: 'completed', output: [
      { type: 'input_text', text: 'Before' },
      { type: 'input_text', text: JSON.stringify([first, second]) },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: JSON.stringify([third]) },
      { type: 'input_text', text: 'After' },
    ],
  });
});

test('buildTargetPayload omits tool_choice when Anthropic Messages omits it', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  });

  assertFalse('tool_choice' in result);
});

test('buildTargetPayload omits tool_choice when Anthropic Messages carries no client tools to apply it to', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hello' }],
    tool_choice: { type: 'any' },
  });

  assertFalse('tool_choice' in result);
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

test('buildTargetPayload drops filtered-native tool_choice and rewrites assistant native web-search history as function-call history', async () => {
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

  // A hosted Messages tool has no declaration on this wire, so the request
  // offers none and states no selector.
  assertEquals(result.tools, undefined);
  assertEquals(result.tool_choice, undefined);
  assertEquals(result.input, [
    {
      type: 'function_call',
      call_id: 'st_1',
      name: 'web_search',
      arguments: '{"query":"React docs"}',
      status: 'completed',
    },
    {
      type: 'function_call_output',
      call_id: 'st_1',
      output: '[{"type":"web_search_result","url":"https://react.dev","title":"React","encrypted_content":"opaque-payload"}]',
      status: 'completed',
    },
  ]);
});

test('buildTargetPayload pairs each server tool round with its own result', async () => {
  const search = (id: string, query: string) => [
    { caller: { type: 'direct' as const }, type: 'server_tool_use' as const, id, name: 'web_search' as const, input: { query } },
    {
      type: 'web_search_tool_result' as const,
      tool_use_id: id,
      content: [{ type: 'web_search_result' as const, url: `https://example.com/${id}`, title: id, encrypted_content: `enc-${id}` }],
    },
  ];
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        // Two search rounds in one message, with the model's own text between
        // and after them.
        content: [
          { type: 'text', text: 'First search.' },
          ...search('st_1', 'a'),
          { type: 'text', text: 'Refining.' },
          ...search('st_2', 'b'),
          { type: 'text', text: 'Final answer.' },
        ],
      },
    ],
  });

  // Each round is a call and its own result, in the order the source stated
  // them: the text that follows a result belongs to the next round, not to the
  // end of the message.
  assertEquals(result.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First search.' }] },
    { type: 'function_call', call_id: 'st_1', name: 'web_search', arguments: '{"query":"a"}', status: 'completed' },
    {
      type: 'function_call_output',
      call_id: 'st_1',
      output: '[{"type":"web_search_result","url":"https://example.com/st_1","title":"st_1","encrypted_content":"enc-st_1"}]',
      status: 'completed',
    },
    // The text between the rounds belongs to the round that follows it.
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Refining.' }] },
    { type: 'function_call', call_id: 'st_2', name: 'web_search', arguments: '{"query":"b"}', status: 'completed' },
    {
      type: 'function_call_output',
      call_id: 'st_2',
      output: '[{"type":"web_search_result","url":"https://example.com/st_2","title":"st_2","encrypted_content":"enc-st_2"}]',
      status: 'completed',
    },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final answer.' }] },
  ]);
});

test('buildTargetPayload folds a trailing server result into the next client turn', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        // The message ends on the result: the search finished but the model
        // said nothing after it.
        content: [
          { type: 'text', text: 'Searching.' },
          { caller: { type: 'direct' as const }, type: 'server_tool_use' as const, id: 'st_1', name: 'web_search' as const, input: { query: 'a' } },
          { type: 'web_search_tool_result' as const, tool_use_id: 'st_1', content: [] },
        ],
      },
      { role: 'user', content: 'Now use those results.' },
    ],
  });

  // The result answers the call, and the client's own message follows it in the
  // same turn rather than opening a second one.
  assertEquals(result.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Searching.' }] },
    { type: 'function_call', call_id: 'st_1', name: 'web_search', arguments: '{"query":"a"}', status: 'completed' },
    { type: 'function_call_output', call_id: 'st_1', output: '[]', status: 'completed' },
    { type: 'message', role: 'user', content: 'Now use those results.' },
  ]);
});

test('buildTargetPayload maps output_config.effort directly to reasoning.effort', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'xhigh' });
  assertFalse('include' in result);
});

test('buildTargetPayload forwards empty output_config.effort verbatim', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: '' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: '' });
});

test('buildTargetPayload prefers output_config.effort over thinking.disabled', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'high' });
});

test('buildTargetPayload preserves output_config.effort max at the translation boundary', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'max' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'max' });
});

test('buildTargetPayload projects thinking.enabled budgets onto reasoning.effort', async () => {
  for (const [budget, effort] of [[1024, 'low'], [16384, 'high']] as const) {
    const result = await buildWithTestSidecar({
      model: 'gpt-test',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: budget },
      messages: [{ role: 'user', content: 'hi' }],
    });

    assertEquals(result.reasoning, { effort });
  }
});

test('buildTargetPayload maps thinking.adaptive to reasoning.effort medium', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'medium' });
});

test('buildTargetPayload never invents reasoning.context from a source thinking block', async () => {
  // The Anthropic Messages thinking shape carries no reasoning-context mode, so the
  // target reasoning object must expose effort only — never a synthesized
  // `all_turns` (or any other) context value.
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 8192 },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'medium' });
  assertEquals(result.reasoning?.context, undefined);
  assertFalse('context' in (result.reasoning ?? {}));
});

test('buildTargetPayload preserves max_tokens at the translation boundary', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.max_output_tokens, 256);
});

test('buildTargetPayload maps thinking.disabled to reasoning.effort none', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'none' });
  assertFalse('include' in result);
});

test('buildTargetPayload preserves explicit temperature and omits translated-path defaults', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    temperature: 0.2,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.temperature, 0.2);
  assertFalse('store' in result);
  assertFalse('parallel_tool_calls' in result);
});

test('buildTargetPayload omits temperature when the source omitted it', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('temperature' in result);
});

test('buildTargetPayload prepends multi-block top-level system as a leading input system message preserving block boundaries', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'Alpha' },
      { type: 'text', text: 'Beta' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('instructions' in result);
  const input = result.input as Array<{ type: string; role?: string; content?: unknown }>;
  assertEquals(input[0], {
    type: 'message',
    role: 'system',
    content: [
      { type: 'input_text', text: 'Alpha' },
      { type: 'input_text', text: 'Beta' },
    ],
  });
});

test('buildTargetPayload keeps a single-block top-level system in canonical `instructions` slot', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    system: [{ type: 'text', text: 'You are helpful.' }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.instructions, 'You are helpful.');
  const input = result.input as Array<{ type: string; role?: string }>;
  assertEquals(input[0].role, 'user');
});

test('buildTargetPayload preserves text-only thinking input', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ signature: '', type: 'thinking', thinking: 'trace' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as OpenAIResponsesInputReasoning;
  assertEquals(reasoning, {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
});

// OpenAI strict-mode JSON Schema validators reject {type: 'object'} without a
// `properties` field. Anthropic accepts that shape, so the input_schema must
// be normalized before forwarding to OpenAI Responses. Ref:
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
      name: 'no_args',
      parameters: { type: 'object', properties: {} },
      strict: false,
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

  const tool = result.tools?.[0] as OpenAIResponsesFunctionTool;
  assertEquals(tool.parameters, {
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

  const tool = result.tools?.[0] as OpenAIResponsesFunctionTool;
  assertEquals(tool.parameters, { type: 'string' });
});

test('buildTargetPayload wraps output_config.format json_schema as text.format with synthesised name and strict', async () => {
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

  assertEquals(result.text, {
    format: { type: 'json_schema', name: 'messages_response', strict: true, schema },
  });
});

test('buildTargetPayload omits text when output_config has no format', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { effort: 'high' },
  });

  assertFalse('text' in result);
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
    "messages.0.content.0.type: 'audio' content blocks are not supported in user content.",
  );
});

test('buildTargetPayload emits in-array role:"system" inline as an OpenAI Responses message input item', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'who are you' },
    ],
  });

  const input = result.input as Array<{ type: string; role?: string; content?: unknown }>;
  assertEquals(input.length, 3);
  assertEquals(input[0].role, 'user');
  assertEquals(input[1], { type: 'message', role: 'system', content: 'be terse' });
  assertEquals(input[2].role, 'user');
});

test('buildTargetPayload preserves in-array system text blocks as separate input_text parts', async () => {
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

  const input = result.input as Array<{ type: string; role?: string; content?: unknown }>;
  assertEquals(input[0], {
    type: 'message',
    role: 'system',
    content: [
      { type: 'input_text', text: 'Para A' },
      { type: 'input_text', text: 'Para B' },
    ],
  });
});

test('buildTargetPayload hoists a leading in-array system message and keeps later ones in place', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'mid-array A' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'mid-array B' },
      { role: 'user', content: 'q2' },
    ],
  });

  // The leading run is what the request states before its first turn, so it is
  // the prompt; a system message after a turn happened stays where it was.
  assertEquals(result.instructions, 'mid-array A');
  const input = result.input as Array<{ type: string; role?: string }>;
  assertEquals(input.length, 4);
  assertEquals(input[0].role, 'user');
  assertEquals(input[1].role, 'assistant');
  assertEquals(input[2].role, 'system');
  assertEquals(input[3].role, 'user');
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

test('buildTargetPayload projects an Anthropic thinking budget onto reasoning.effort', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 4096 },
  });

  assertEquals(result.reasoning, { effort: 'medium' });
});

// ── speed ↔ service_tier bridge ──

test('buildTargetPayload maps speed:fast to service_tier:fast on the outbound OpenAI Responses payload', async () => {
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

test('buildTargetPayload forwards Anthropic service_tier to OpenAI Responses when speed is absent', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'auto');
});

test('buildTargetPayload forwards service_tier:standard_only to OpenAI Responses when speed is absent', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'standard_only',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'standard_only');
});

test('preserves expressible Messages metadata extensions and rejects non-string values', async () => {
  const payload = { model: 'm', max_tokens: 16, messages: [], metadata: { user_id: 'u', tenant: 't' } };
  assertEquals((await buildWithTestSidecar(payload)).metadata, { user_id: 'u', tenant: 't' });
  await assertRejects(() => buildWithTestSidecar({ ...payload, metadata: { user_id: 'u', tenant: { nested: 't' } } } as AnthropicMessagesPayload), undefined, "metadata field 'tenant'");
});

test.each([true, false])('maps disable_parallel_tool_use %s without changing declarations', async disabled => {
  const result = await buildWithTestSidecar({
    model: 'm', max_tokens: 32, messages: [],
    tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: disabled },
  });
  assertEquals(result.parallel_tool_calls, !disabled);
  assertEquals(result.tools?.length, 1);
});
