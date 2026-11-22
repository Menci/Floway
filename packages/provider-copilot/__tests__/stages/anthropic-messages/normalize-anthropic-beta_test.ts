import { test } from 'vitest';

import { anthropicMessagesStages } from '../../../src/stages/anthropic-messages/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const baseBody = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('synthesizes interleaved thinking only when the caller supplied no beta intent', async () => {
  const payload = { ...baseBody, thinking: { type: 'enabled' as const, budget_tokens: 1024 } };
  assertEquals((await inspectRequestStage(anthropicMessagesStages, 'normalize-anthropic-beta', payload)).headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
  const { headers } = await inspectRequestStage(anthropicMessagesStages, 'normalize-anthropic-beta', payload, { beta: ['context-1m-2025-08-07'] });
  assertEquals(headers.get('anthropic-beta'), null);
});

test('pairs context management with its required beta token', async () => {
  const payload = { ...baseBody, context_management: { edits: [] } } as AnthropicMessagesPayload & { context_management: unknown };
  const { headers } = await inspectRequestStage(anthropicMessagesStages, 'normalize-anthropic-beta', payload, { beta: ['interleaved-thinking-2025-05-14'] });
  assertEquals(headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});
