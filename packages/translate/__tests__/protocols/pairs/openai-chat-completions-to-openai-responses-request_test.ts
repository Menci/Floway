import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertFalse } from '@floway-dev/test-utils';

const buildWithTestSidecar = (payload: OpenAIChatCompletionsPayloadEx) =>
  buildTargetPayloadFor(pairs.chatToResponses[0], pairs.chatToResponses[1], { ...payload, stream: true }, { sidecarCodec: createTestSidecarCodec() });

test.each(['none', { name: 'lookup' }] as const)('translates legacy declarations and choice %j into modern tooling', async function_call => {
  const result = await buildWithTestSidecar({
    model: 'model', messages: [],
    functions: [{ name: 'lookup', description: 'Look up facts', parameters: { type: 'object', properties: {} } }],
    function_call,
  });
  assertEquals(result.tools, [{ type: 'function', name: 'lookup', description: 'Look up facts', parameters: { type: 'object', properties: {} }, strict: false }]);
  assertEquals(result.tool_choice, typeof function_call === 'string' ? function_call : { type: 'function', name: 'lookup' });
  assertFalse('functions' in result);
  assertFalse('function_call' in result);
});

test('buildTargetPayload maps native custom tool declarations and choices', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'custom', custom: { name: 'apply_patch', format: { type: 'text' } } }],
    tool_choice: { type: 'custom', custom: { name: 'apply_patch' } },
  });
  assertEquals(result.tools, [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }]);
  assertEquals(result.tool_choice, { type: 'custom', name: 'apply_patch' });
});

test('buildTargetPayload maps custom tool history and its output', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_patch', type: 'custom', custom: { name: 'apply_patch', input: 'patch text' } }] },
      { role: 'tool', tool_call_id: 'call_patch', content: 'applied' },
    ],
  });
  assertEquals(result.input, [
    { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: 'patch text', status: 'completed' },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'applied' },
  ]);
});

test('buildTargetPayload preserves translated OpenAI request fields', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    response_format: { type: 'json_schema', json_schema: { name: 'shape', schema: {} } },
    metadata: { trace_id: 'abc' },
    store: true,
    parallel_tool_calls: false,
    reasoning_effort: 'medium',
    prompt_cache_key: 'cache-key',
    safety_identifier: 'safe-id',
  });

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

test('buildTargetPayload keeps historical system and developer messages inline', async () => {
  const result = await buildWithTestSidecar({
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

  assertEquals(result.instructions, undefined);
  assertEquals(result.input, [
    { type: 'message', role: 'system', content: 'sys-1' },
    { type: 'message', role: 'system', content: 'sys-2' },
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

test('allowed_tools retains both native callable kinds', async () => {
  const result = await buildWithTestSidecar({
    model: 'gpt-test', messages: [], tools: [
      { type: 'function', function: { name: 'lookup' } }, { type: 'custom', custom: { name: 'edit' } },
    ], tool_choice: {
      type: 'allowed_tools', allowed_tools: {
        mode: 'required', tools: [
          { type: 'function', function: { name: 'lookup' } }, { type: 'custom', custom: { name: 'edit' } },
        ],
      },
    },
  });
  assertEquals(result.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'lookup' }, { type: 'custom', name: 'edit' }] });
});
