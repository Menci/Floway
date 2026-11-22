import { test } from 'vitest';

import { normalizeCopilotAnthropicBeta } from '../../../src/stages/anthropic-messages/normalize-anthropic-beta.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const baseBody = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('synthesizes interleaved thinking only when the caller supplied no beta intent', () => {
  const payload = { ...baseBody, thinking: { type: 'enabled' as const, budget_tokens: 1024 } };
  assertEquals(normalizeCopilotAnthropicBeta([], payload), ['interleaved-thinking-2025-05-14']);
  assertEquals(normalizeCopilotAnthropicBeta(['context-1m-2025-08-07'], payload), []);
});

test('pairs context management with its required beta token', () => {
  const payload = { ...baseBody, context_management: { edits: [] } } as AnthropicMessagesPayload & { context_management: unknown };
  assertEquals(normalizeCopilotAnthropicBeta(['interleaved-thinking-2025-05-14'], payload), [
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
  ]);
});
