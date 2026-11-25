import { test } from 'vitest';

import { normalizeAnthropicBeta } from '../../../src/pipelines/anthropic-messages/normalize-anthropic-beta.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (
  payload: AnthropicMessagesPayload & { context_management?: unknown },
  anthropicBeta: string[] = [],
): StageFixture<'anthropicMessages'> => ({
  payload: payload as AnthropicMessagesPayload,
  headers: new Headers(),
  anthropicBeta,
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

const baseBody = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('synthesizes interleaved thinking only when the caller supplied no beta intent', async () => {
  const payload = { ...baseBody, thinking: { type: 'enabled' as const, budget_tokens: 1024 } };
  const stage = normalizeAnthropicBeta('anthropicMessages');
  const silent = await inspectStages('anthropicMessages', stage, invocation(payload));
  const explicit = await inspectStages('anthropicMessages', stage, invocation(payload, ['context-1m-2025-08-07']));
  assertEquals(silent.anthropicBeta, ['interleaved-thinking-2025-05-14']);
  assertEquals(explicit.anthropicBeta, []);
});

test('pairs context management with its required beta token', async () => {
  const fixture = invocation(
    { ...baseBody, context_management: { edits: [] } },
    ['interleaved-thinking-2025-05-14'],
  );
  const ctx = await inspectStages('anthropicMessages', normalizeAnthropicBeta('anthropicMessages'), fixture);
  assertEquals(ctx.anthropicBeta, [
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
  ]);
});
