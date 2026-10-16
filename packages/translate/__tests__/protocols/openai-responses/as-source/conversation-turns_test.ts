import { expect, test } from 'vitest';

import { partitionOpenAIResponsesTurns } from '../../../../src/protocols/openai-responses/as-source/conversation-turns.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

test.each(['additional_tools', 'tool_search_output'] as const)('%s belongs to the user side and separates assistant turns', type => {
  const first: CanonicalOpenAIResponsesInputItem = { type: 'function_call', call_id: 'first', name: 'lookup', arguments: '{}' };
  const second: CanonicalOpenAIResponsesInputItem = { type: 'function_call', call_id: 'second', name: 'lookup', arguments: '{}' };
  const output: CanonicalOpenAIResponsesInputItem = { type: 'function_call_output', call_id: 'first', output: 'result' };
  const inventory: CanonicalOpenAIResponsesInputItem = type === 'additional_tools'
    ? { type, role: 'developer', tools: [] }
    : { type, call_id: 'load', execution: 'client', tools: [] };

  expect(partitionOpenAIResponsesTurns([inventory, first, output, inventory, second, inventory])).toEqual([
    { role: 'bare', items: [inventory] },
    { role: 'assistant', items: [first] },
    { role: 'bare', items: [output, inventory] },
    { role: 'assistant', items: [second] },
    { role: 'bare', items: [inventory] },
  ]);
});
