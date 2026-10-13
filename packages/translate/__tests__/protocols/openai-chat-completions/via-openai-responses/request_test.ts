import { expect, test } from 'vitest';

import { buildTargetRequest } from '../../../../src/protocols/openai-chat-completions/via-openai-responses/request.ts';
import { TranslatorInputError } from '../../../../src/translator-input-error.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertFalse, assertRejects } from '@floway-dev/test-utils';

test('buildTargetRequest preserves scalar and content-part assistant refusals', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [
      { role: 'assistant', content: null, refusal: 'Scalar refusal.' },
      { role: 'assistant', content: [{ type: 'refusal', refusal: 'Part refusal.' }] },
    ],
  }, createTestSidecarCodec());
  assertEquals(result.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Scalar refusal.' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Part refusal.' }] },
  ]);
});
test('buildTargetRequest uses rs-prefixed ids for reasoning input items', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_text: 'trace',
        reasoning_opaque: 'enc',
      } as OpenAIChatCompletionsAssistantMessageEx,
    ],
  }, createTestSidecarCodec());
  if (!Array.isArray(result.input))
    throw new Error('expected input array');
  const reasoning = result.input[0] as OpenAIResponsesInputReasoning;
  assertEquals(reasoning.type, 'reasoning');
  expect(reasoning.id).toMatch(/^rs_[0-9a-f]{32}$/);
});
test('buildTargetRequest preserves text-only scalar reasoning', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_text: 'visible trace',
      } as OpenAIChatCompletionsAssistantMessageEx,
    ],
  }, createTestSidecarCodec());
  if (!Array.isArray(result.input))
    throw new Error('expected input array');
  assertEquals(result.input[0], {
    type: 'reasoning',
    id: expect.stringMatching(/^rs_[0-9a-f]{32}$/),
    summary: [{ type: 'summary_text', text: 'visible trace' }],
  });
});
test('buildTargetRequest prefers reasoning_items over scalar reasoning', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_text: 'legacy trace',
        reasoning_opaque: 'legacy_enc',
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_existing',
            summary: [{ type: 'summary_text', text: 'first' }],
          },
          {
            type: 'reasoning',
            summary: [],
          },
        ],
      } as OpenAIChatCompletionsAssistantMessageEx,
    ],
  }, createTestSidecarCodec());
  if (!Array.isArray(result.input))
    throw new Error('expected input array');
  assertEquals(result.input.filter(item => item.type === 'reasoning'), [
    {
      type: 'reasoning',
      id: 'rs_existing',
      summary: [{ type: 'summary_text', text: 'first' }],
    },
  ]);
});
test('buildTargetRequest rejects tool messages without tool_call_id', async () => {
  await assertRejects(async () => await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'tool', content: 'result' } as unknown as OpenAIChatCompletionsMessage],
  }, createTestSidecarCodec()), Error, 'tool_call_id');
});
test('buildTargetRequest maps native custom tool declarations and choices', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'custom', custom: { name: 'apply_patch', format: { type: 'text' } } }],
    tool_choice: { type: 'custom', custom: { name: 'apply_patch' } },
  }, createTestSidecarCodec());
  assertEquals(result.tools, [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }]);
  assertEquals(result.tool_choice, { type: 'custom', name: 'apply_patch' });
});
test('buildTargetRequest maps custom tool history and its output', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_patch', type: 'custom', custom: { name: 'apply_patch', input: 'patch text' } }] },
      { role: 'tool', tool_call_id: 'call_patch', content: 'applied' },
    ],
  }, createTestSidecarCodec());
  assertEquals(result.input, [
    { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: 'patch text', status: 'completed' },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'applied' },
  ]);
});
test('buildTargetRequest preserves translated OpenAI request fields', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    response_format: { type: 'json_schema', json_schema: { name: 'shape', schema: {} } },
    metadata: { trace_id: 'abc' },
    store: true,
    parallel_tool_calls: false,
    reasoning_effort: 'medium',
    prompt_cache_key: 'cache-key',
    safety_identifier: 'safe-id',
  }, createTestSidecarCodec());
  assertEquals(result.text, {
    format: { type: 'json_schema', name: 'shape', schema: {} },
  });
  assertEquals(result.metadata, { trace_id: 'abc' });
  assertEquals(result.store, true);
  assertEquals(result.parallel_tool_calls, false);
  assertEquals(result.reasoning, { effort: 'medium' });
  assertEquals(result.prompt_cache_key, 'cache-key');
  assertEquals(result.safety_identifier, 'safe-id');
  assertFalse('include' in result);
});
test('buildTargetRequest forwards empty reasoning_effort verbatim', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: '',
  }, createTestSidecarCodec());
  assertEquals(result.reasoning, { effort: '' });
});
test('buildTargetRequest never invents reasoning.context from reasoning_effort', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: 'high',
  }, createTestSidecarCodec());
  assertEquals(result.reasoning, { effort: 'high' });
  assertEquals(result.reasoning?.context, undefined);
  assertFalse('context' in (result.reasoning ?? {}));
});
test('buildTargetRequest omits store when OpenAI Chat Completions omits store', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  }, createTestSidecarCodec());
  assertFalse('store' in result);
});
test('buildTargetRequest omits tool_choice when OpenAI Chat Completions omits it', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  }, createTestSidecarCodec());
  assertFalse('tool_choice' in result);
});
test('buildTargetRequest omits tool_choice when OpenAI Chat Completions carries no tools to apply it to', async () => {
  for (const tools of [undefined, null, []]) {
    const result = await buildTargetRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: 'required',
      tools: tools as OpenAIChatCompletionsPayload['tools'],
    }, createTestSidecarCodec());
    assertFalse('tool_choice' in result);
  }
});
test('buildTargetRequest preserves explicit null prompt cache and safety fields', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    prompt_cache_key: null,
    safety_identifier: null,
  }, createTestSidecarCodec());
  assertEquals('prompt_cache_key' in result, true);
  assertEquals(result.prompt_cache_key, null);
  assertEquals('safety_identifier' in result, true);
  assertEquals(result.safety_identifier, null);
});
test('buildTargetRequest hoists only the initial contiguous system prefix', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'sys-1' },
      { role: 'system', content: 'sys-2' },
      { role: 'user', content: 'u1' },
      { role: 'developer', content: 'dev-late' },
      { role: 'system', content: 'sys-late' },
      { role: 'assistant', content: 'a1' },
    ],
  }, createTestSidecarCodec());
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
test('buildTargetRequest preserves explicit tool strict and defaults omission to false', async () => {
  const result = await buildTargetRequest({
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
  }, createTestSidecarCodec());
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
test('buildTargetRequest rejects an unknown message role', async () => {
  await assertRejects(async () => await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'function', content: 'hi' } as unknown as OpenAIChatCompletionsMessage],
  }, createTestSidecarCodec()), Error, "Invalid role 'function'");
});
test('buildTargetRequest forwards reasoning_effort and service_tier onto the native slots', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'medium',
    service_tier: 'priority',
  }, createTestSidecarCodec());
  assertEquals(result.reasoning, { effort: 'medium' });
  assertEquals(result.service_tier, 'priority');
});
test.each(['none', '', 'future_effort'])('buildTargetRequest forwards reasoning_effort=%j verbatim', async reasoning_effort => {
  const result = await buildTargetRequest({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort,
  }, createTestSidecarCodec());
  assertEquals(result.reasoning, { effort: reasoning_effort });
});
test.each([null, undefined])('buildTargetRequest omits unset reasoning_effort=%j', async reasoning_effort => {
  const result = await buildTargetRequest({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], reasoning_effort }, createTestSidecarCodec());
  assertEquals(Object.hasOwn(result, 'reasoning'), false);
});
test('rejects a json_schema request with no schema instead of removing constraints', async () => {
  await assertRejects(async () => await buildTargetRequest({ model: 'gpt-test', messages: [], response_format: { type: 'json_schema', json_schema: { name: 'shape' } } }, createTestSidecarCodec()), TranslatorInputError, 'without a schema');
});
test('allowed_tools retains both native callable kinds', async () => {
  const result = await buildTargetRequest({
    model: 'gpt-test', messages: [], tools: [
      { type: 'function', function: { name: 'lookup' } }, { type: 'custom', custom: { name: 'edit' } },
    ], tool_choice: {
      type: 'allowed_tools', allowed_tools: {
        mode: 'required', tools: [
          { type: 'function', function: { name: 'lookup' } }, { type: 'custom', custom: { name: 'edit' } },
        ],
      },
    },
  }, createTestSidecarCodec());
  assertEquals(result.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'lookup' }, { type: 'custom', name: 'edit' }] });
});
