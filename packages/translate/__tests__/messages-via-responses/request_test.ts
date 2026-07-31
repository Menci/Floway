import { expect, test } from 'vitest';

import { buildTargetRequest } from '../../src/messages-via-responses/request.ts';
import { packReasoningSignature } from '../../src/shared/messages-and-responses/reasoning.ts';
import type { MessagesAssistantContentBlock, MessagesUserContentBlock } from '@floway-dev/protocols/messages';
import type { ResponsesFunctionTool, ResponsesInputReasoning } from '@floway-dev/protocols/responses';
import { assertEquals, assertFalse, assertThrows } from '@floway-dev/test-utils';

test('buildTargetRequest preserves a native thinking signature as encrypted_content with a synthesized id', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'trace', signature: 'sig' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponsesInputReasoning;
  assertEquals(reasoning, {
    type: 'reasoning',
    id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
    summary: [{ type: 'summary_text', text: 'trace' }],
    encrypted_content: 'sig',
  });
});

test('buildTargetRequest recovers Responses ids and encrypted_content from packed thinking signatures', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'trace',
            signature: packReasoningSignature('rs_42', 'opaque'),
          },
        ],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponsesInputReasoning;
  assertEquals(reasoning, {
    type: 'reasoning',
    id: 'rs_42',
    summary: [{ type: 'summary_text', text: 'trace' }],
    encrypted_content: 'opaque',
  });
});

test('buildTargetRequest recovers an empty-front packed signature as id-only reasoning', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_7', '') }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponsesInputReasoning;
  assertEquals(reasoning, {
    type: 'reasoning',
    id: 'rs_7',
    summary: [{ type: 'summary_text', text: 'trace' }],
    encrypted_content: '',
  });
});

test('buildTargetRequest omits tool_choice when Messages omits it', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  });

  assertFalse('tool_choice' in result);
});

test('buildTargetRequest omits tool_choice when Messages carries no client tools to apply it to', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hello' }],
    tool_choice: { type: 'any' },
  });

  assertFalse('tool_choice' in result);
});

test('buildTargetRequest drops filtered-native tool_choice and rewrites assistant native web-search history as function-call history', () => {
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

  assertEquals(result.tools, null);
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

test('buildTargetRequest maps output_config.effort directly to reasoning.effort', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'xhigh' });
  assertFalse('include' in result);
});

test('buildTargetRequest prefers output_config.effort over thinking.disabled', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'high' });
});

test('buildTargetRequest preserves output_config.effort max at the translation boundary', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'max' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'max' });
});

test('buildTargetRequest maps thinking.enabled to reasoning.effort medium regardless of budget_tokens', () => {
  for (const budget of [undefined, 1024, 16384]) {
    const result = buildTargetRequest({
      model: 'gpt-test',
      max_tokens: 4096,
      thinking: budget === undefined ? { type: 'enabled' } : { type: 'enabled', budget_tokens: budget },
      messages: [{ role: 'user', content: 'hi' }],
    });

    assertEquals(result.reasoning, { effort: 'medium' });
  }
});

test('buildTargetRequest maps thinking.adaptive to reasoning.effort medium', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'medium' });
});

test('buildTargetRequest never invents reasoning.context from a source thinking block', () => {
  // The Messages thinking shape carries no reasoning-context mode, so the
  // target reasoning object must expose effort only — never a synthesized
  // `all_turns` (or any other) context value.
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 8192 },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'medium' });
  assertEquals(result.reasoning?.context, undefined);
  assertFalse('context' in (result.reasoning ?? {}));
});

test('buildTargetRequest preserves max_tokens at the translation boundary', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.max_output_tokens, 256);
});

test('buildTargetRequest maps thinking.disabled to reasoning.effort none', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'none' });
  assertFalse('include' in result);
});

test('buildTargetRequest preserves explicit temperature and omits translated-path defaults', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    temperature: 0.2,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.temperature, 0.2);
  assertFalse('store' in result);
  assertFalse('parallel_tool_calls' in result);
});

test('buildTargetRequest omits temperature when the source omitted it', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('temperature' in result);
});

test('buildTargetRequest prepends multi-block top-level system as a leading input system message preserving block boundaries', () => {
  const result = buildTargetRequest({
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

test('buildTargetRequest keeps a single-block top-level system in canonical `instructions` slot', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    system: [{ type: 'text', text: 'You are helpful.' }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.instructions, 'You are helpful.');
  const input = result.input as Array<{ type: string; role?: string }>;
  assertEquals(input[0].role, 'user');
});

test('buildTargetRequest preserves redacted_thinking as a native-signature reasoning item', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'opaque_sig' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  assertEquals(result.input, [
    {
      type: 'reasoning',
      id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
      summary: [],
      encrypted_content: 'opaque_sig',
    },
  ]);
});

test('buildTargetRequest recovers id and encrypted_content from packed redacted_thinking data', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: packReasoningSignature('rs_99', 'opaque_sig') }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  assertEquals(result.input, [
    {
      type: 'reasoning',
      id: 'rs_99',
      summary: [],
      encrypted_content: 'opaque_sig',
    },
  ]);
});

test('buildTargetRequest preserves text-only thinking input', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'trace' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponsesInputReasoning;
  assertEquals(reasoning, {
    type: 'reasoning',
    id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
});

// OpenAI strict-mode JSON Schema validators reject {type: 'object'} without a
// `properties` field. Anthropic accepts that shape, so the input_schema must
// be normalized before forwarding to Responses. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
test('buildTargetRequest defaults missing input_schema.properties to {} for object tools', () => {
  const result = buildTargetRequest({
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
  });

  const tool = result.tools?.[0] as ResponsesFunctionTool;
  assertEquals(tool.parameters, {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  });
});

test('buildTargetRequest does not inject properties for non-object input_schema', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    tools: [{ name: 'scalar', input_schema: { type: 'string' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  const tool = result.tools?.[0] as ResponsesFunctionTool;
  assertEquals(tool.parameters, { type: 'string' });
});

test('buildTargetRequest wraps output_config.format json_schema as text.format with synthesised name and strict', () => {
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
  });

  assertEquals(result.text, {
    format: { type: 'json_schema', name: 'messages_response', strict: true, schema },
  });
});

test('buildTargetRequest omits text when output_config has no format', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hi' }],
    output_config: { effort: 'high' },
  });

  assertFalse('text' in result);
});

test('buildTargetRequest rejects an unknown assistant content block type', () => {
  assertThrows(
    () =>
      buildTargetRequest({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'assistant', content: [{ type: 'audio' } as unknown as MessagesAssistantContentBlock] }],
      }),
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
        messages: [{ role: 'user', content: [{ type: 'audio' } as unknown as MessagesUserContentBlock] }],
      }),
    Error,
    "messages.0.content.0.type: 'audio' user content blocks are not supported",
  );
});

test('buildTargetRequest emits in-array role:"system" inline as a Responses message input item', () => {
  const result = buildTargetRequest({
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

test('buildTargetRequest preserves in-array system text blocks as separate input_text parts', () => {
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

test('buildTargetRequest preserves chronology of multiple in-array system messages', () => {
  const result = buildTargetRequest({
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

  const input = result.input as Array<{ type: string; role?: string }>;
  assertEquals(input.length, 5);
  assertEquals(input[0].role, 'system');
  assertEquals(input[1].role, 'user');
  assertEquals(input[2].role, 'assistant');
  assertEquals(input[3].role, 'system');
  assertEquals(input[4].role, 'user');
});

test('buildTargetRequest rejects an unknown message role', () => {
  assertThrows(
    () =>
      buildTargetRequest({
        model: 'gpt-test',
        max_tokens: 256,
        messages: [{ role: 'tool', content: 'oops' } as unknown as { role: 'user'; content: string }],
      }),
    Error,
    "messages.0.role: role 'tool' is not supported",
  );
});

test('buildTargetRequest collapses Anthropic thinking mode onto reasoning.effort only', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 4096 },
  });

  // `thinking.type === 'enabled'` resolves to the OpenAI-canonical `medium`
  // effort; the `budget_tokens` scalar has no Responses slot and drops.
  assertEquals(result.reasoning, { effort: 'medium' });
});

// ── speed ↔ service_tier bridge ──

test('buildTargetRequest maps speed:fast to service_tier:fast on the outbound Responses payload', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    speed: 'fast',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'fast');
});

test('buildTargetRequest omits service_tier when speed is absent', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('service_tier' in result);
});

test('buildTargetRequest drops speed values other than fast without emitting service_tier', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    speed: 'standard',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('service_tier' in result);
});

test('buildTargetRequest forwards Anthropic service_tier to Responses when speed is absent', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'auto');
});

test('buildTargetRequest forwards service_tier:standard_only to Responses when speed is absent', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    max_tokens: 256,
    service_tier: 'standard_only',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.service_tier, 'standard_only');
});
