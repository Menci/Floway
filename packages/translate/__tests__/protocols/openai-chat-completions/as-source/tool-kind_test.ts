import { test } from 'vitest';

import type { IRInputTurn } from '../../../../src/ir/input/types.ts';
import { openaiChatCompletionsRead } from '../../../../src/protocols/openai-chat-completions/as-source/input-to.ts';
import { assertEquals } from '@floway-dev/test-utils';

const itemsOf = (turns: readonly IRInputTurn[]) => turns.flatMap(turn => [...turn.items]);

test('a tool result keeps the call kind even when a sidecar states the turn that made the call', () => {
  const reading = openaiChatCompletionsRead({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', tool_calls: [{ id: 'call_patch', type: 'custom', custom: { name: 'apply_patch', input: 'x' } }] },
      { role: 'tool', tool_call_id: 'call_patch', content: 'ok' },
    ],
  });

  // The target writes the assistant slot natively, so its `toIRInputTurns` never
  // runs. The kind of its call is still needed by the result that answers it,
  // which is why opening names every declared call before reading.
  const turns = reading.turns.flatMap(turn => (turn.kind === 'assistant' ? [] : turn.toIRInputTurns()));

  const result = itemsOf(turns).find(item => item.type === 'tool_result');
  assertEquals(result?.type === 'tool_result' ? result.tool_kind : undefined, 'custom');
});
