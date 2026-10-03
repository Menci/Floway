import { expect, test } from 'vitest';

import { buildTargetRequest } from '../../src/openai-chat-completions-via-openai-responses/request.ts';
import { encodeChatCompletionsReasoningData, flowayReasoningFields } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertFalse, assertThrows } from '@floway-dev/test-utils';

test('buildTargetRequest preserves scalar and content-part assistant refusals', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    messages: [
      { role: 'assistant', content: null, refusal: 'Scalar refusal.' },
      { role: 'assistant', content: [{ type: 'refusal', refusal: 'Part refusal.' }] },
    ],
  });

  assertEquals(result.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Scalar refusal.' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Part refusal.' }] },
  ]);
});

test.each([
  ['trace', 'enc'],
  ['visible trace', ''],
  ['', 'enc'],
])('buildTargetRequest ignores scalar reasoning history (%s, %s)', (text, opaque) => {
  const result = buildTargetRequest({
    model: 'gpt-test', messages: [
      { role: 'assistant', content: 'answer', ...flowayReasoningFields(text, opaque) },
    ],
  });
  assertEquals(result.input, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }]);
});

test('buildTargetRequest restores native items including empty-summary history', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        content: 'answer',
        ...flowayReasoningFields('legacy trace', (encodeChatCompletionsReasoningData('litellm-reasoning-items', [
          {
            type: 'reasoning',
            id: 'rs_existing',
            summary: [{ type: 'summary_text', text: 'first' }],
          },
          {
            type: 'reasoning',
            id: 'rs_empty',
            summary: [],
          },
        ])) ?? ''),

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
    { type: 'reasoning', id: 'rs_empty', summary: [] },
  ]);
});

test('buildTargetRequest rejects tool messages without tool_call_id', () => {
  assertThrows(
    () =>
      buildTargetRequest({
        model: 'gpt-test',
        messages: [{ role: 'tool', content: 'result' }],
      }),
    Error,
    'tool_call_id',
  );
});

test('buildTargetRequest preserves translated OpenAI request fields', () => {
  const result = buildTargetRequest({
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

test('buildTargetRequest never invents reasoning.context from reasoning_effort', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: 'high',
  });

  assertEquals(result.reasoning, { effort: 'high' });
  assertEquals(result.reasoning?.context, undefined);
  assertFalse('context' in (result.reasoning ?? {}));
});

test('buildTargetRequest omits store when OpenAI Chat Completions omits store', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assertFalse('store' in result);
});

test('buildTargetRequest omits tool_choice when OpenAI Chat Completions omits it', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  });

  assertFalse('tool_choice' in result);
});

test('buildTargetRequest omits tool_choice when OpenAI Chat Completions carries no tools to apply it to', () => {
  for (const tools of [undefined, null, []]) {
    const result = buildTargetRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: 'required',
      tools,
    });

    assertFalse('tool_choice' in result);
  }
});

test('buildTargetRequest preserves explicit null prompt cache and safety fields', () => {
  const result = buildTargetRequest({
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

test('buildTargetRequest hoists only the initial contiguous system prefix', () => {
  const result = buildTargetRequest({
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

test('buildTargetRequest preserves explicit tool strict and defaults omission to false', () => {
  const result = buildTargetRequest({
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

test('buildTargetRequest rejects an unknown message role', () => {
  assertThrows(
    () =>
      buildTargetRequest({
        model: 'gpt-test',
        messages: [{ role: 'function', content: 'hi' } as unknown as OpenAIChatCompletionsMessage],
      }),
    Error,
    "Invalid role 'function'",
  );
});

test('buildTargetRequest forwards reasoning_effort and service_tier onto the native slots', () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'medium',
    service_tier: 'priority',
  });

  assertEquals(result.reasoning, { effort: 'medium' });
  assertEquals(result.service_tier, 'priority');
});

test("buildTargetRequest drops reasoning_effort='none' since OpenAI Responses has no equivalent", () => {
  const result = buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  assertEquals(result.reasoning, undefined);
});

test('native Responses replay forwards the original opaque blob', () => {
  const result = buildTargetRequest({ model: 'm', messages: [{ role: 'assistant', content: null, ...flowayReasoningFields('plan', encodeChatCompletionsReasoningData('litellm-reasoning-items', [{ type: 'reasoning', id: 'rs_signed', summary: [], encrypted_content: 'native-ciphertext' }])) }] });
  expect(result.input[0]).toMatchObject({ type: 'reasoning', encrypted_content: 'native-ciphertext' });
});
