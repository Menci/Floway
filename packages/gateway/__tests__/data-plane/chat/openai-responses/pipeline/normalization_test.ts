import { expect, test } from 'vitest';

import { inspectResponsesShaping } from './fixtures.ts';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [{ type: 'message', role: 'user', content: 'hello' }] };

test('rewrites tool_choice only when the explicit tool inventory is empty', async () => {
  const flag = ['empty-tools-tool-choice-none'] as const;
  const empty = await inspectResponsesShaping({ ...request, tools: [], tool_choice: 'auto' }, flag);
  expect(empty.payload).toMatchObject({ tools: [], tool_choice: 'none' });

  const tool = { type: 'web_search' as const };
  for (const item of [
    { type: 'additional_tools' as const, role: 'developer' as const, tools: [tool] },
    { type: 'tool_search_output' as const, tools: [tool] },
  ]) {
    const active = await inspectResponsesShaping({ ...request, tools: [], input: [item], tool_choice: 'required' }, flag);
    expect(active.payload?.tool_choice).toBe('required');
  }
});

test.each([
  ['required', 'none'],
  [{ type: 'function', name: 'pick' }, 'none'],
  ['auto', 'high'],
] as const)('uses the candidate reasoning policy for tool_choice %j', async (tool_choice, effort) => {
  const shaped = await inspectResponsesShaping({ ...request, tool_choice, reasoning: { effort: 'high' } }, ['disable-reasoning-on-forced-tool-choice']);
  expect(shaped.payload?.reasoning).toEqual({ effort });
});

test('keeps client storage and cache input while applying upstream flags to the wire request', async () => {
  const original = { ...request, store: true, prompt_cache_key: 'caller-cache', prompt_cache_retention: '24h' };
  const shaped = await inspectResponsesShaping(original, ['openai-responses-store-false', 'strip-prompt-cache-key']);
  expect(shaped.payload).toEqual({ ...request, store: false, prompt_cache_retention: '24h' });
  expect(original).toMatchObject({ store: true, prompt_cache_key: 'caller-cache' });
});

test('role compatibility respects a non-message boundary and applies flags in protocol order', async () => {
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'message', role: 'system', content: 'base rules' },
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'message', role: 'system', content: 'inline rules' },
  ];
  const shaped = await inspectResponsesShaping({ ...request, input }, [
    'rewrite-system-to-developer', 'rewrite-developer-to-system', 'rewrite-mid-conv-system-to-user',
  ]);
  expect(shaped.payload?.input).toEqual([
    input[0], input[1], { type: 'message', role: 'user', content: 'inline rules' },
  ]);
});

test('native normalization folds both cached reads and writes into inclusive input usage', async () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 120, cache_write_tokens: 80 },
  } as NonNullable<OpenAIResponsesResultEx['usage']>;
  const shaped = await inspectResponsesShaping(request, ['usage-exclusive-cached-tokens'], 'openaiResponses', [{
    type: 'response.completed',
    response: { id: 'resp_test', object: 'response', model: 'm', status: 'completed', output: [], error: null, incomplete_details: null, usage },
  }]);
  expect(shaped.events?.[0]).toMatchObject({ response: { usage: { ...usage, input_tokens: 300 } } });
});

test('unresolved call namespaces found in an earlier tool inventory become explicit null', async () => {
  const shaped = await inspectResponsesShaping({
    ...request,
    input: [
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'group', description: '', tools: [{ type: 'function', name: 'read', parameters: {} }] }] },
      { type: 'function_call', name: 'read', call_id: 'fc_read', arguments: '{}' },
    ],
  }, ['openai-responses-null-unresolved-function-call-namespace']);
  expect(shaped.payload?.input[1]).toMatchObject({ type: 'function_call', name: 'read', namespace: null });
});
