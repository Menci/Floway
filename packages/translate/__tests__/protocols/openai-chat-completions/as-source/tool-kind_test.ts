import { test } from 'vitest';

import type { IRInputTurn } from '../../../../src/ir/input/types.ts';
import { openaiChatCompletionsSource } from '../../../../src/protocols/openai-chat-completions/as-source/input-to.ts';
import { assertEquals } from '@floway-dev/test-utils';

const itemsOf = (turns: readonly IRInputTurn[]) => turns.flatMap(turn => [...turn.items]);

test('a tool result keeps the call kind even when a resolved turn stated the call', () => {
  const source = openaiChatCompletionsSource({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', tool_calls: [{ id: 'call_patch', type: 'custom', custom: { name: 'apply_patch', input: 'x' } }] },
      { role: 'tool', tool_call_id: 'call_patch', content: 'ok' },
    ],
  } as never);

  // The route writes the assistant turn natively, so it never reaches
  // `turnToIR`. The kind of its call is still needed by the result that answers
  // it, which is why the reader names every declared call before reading.
  const turns = source.conversation.flatMap(turn => (turn.role === 'assistant'
    ? (source.observeResolvedTurn(turn, []), [])
    : source.turnToIR(turn)));

  const result = itemsOf(turns).find(item => item.type === 'tool_result');
  assertEquals(result?.type === 'tool_result' ? result.tool_kind : undefined, 'custom');
});
