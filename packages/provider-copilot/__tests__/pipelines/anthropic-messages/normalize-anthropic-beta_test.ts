import { expect, test } from 'vitest';

import { normalizeAnthropicBeta } from '../../../src/pipelines/anthropic-messages/normalize-anthropic-beta.ts';
import { runStage } from '../stage.ts';

const body = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('synthesizes interleaved thinking only when the caller supplied no beta intent', async () => {
  const payload = { ...body, thinking: { type: 'enabled' as const, budget_tokens: 1024 } };
  const silent = await runStage(normalizeAnthropicBeta, 'anthropicMessages', { payload });
  const explicit = await runStage(normalizeAnthropicBeta, 'anthropicMessages', {
    payload,
    headers: new Headers({ 'anthropic-beta': 'context-1m-2025-08-07' }),
  });
  expect(silent.headers.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14');
  expect(explicit.headers.get('anthropic-beta')).toBeNull();
});

test('pairs context management with its required beta token', async () => {
  const payload = { ...body, context_management: { edits: [] } };
  const result = await runStage(normalizeAnthropicBeta, 'anthropicMessages', {
    payload,
    headers: new Headers({ 'anthropic-beta': 'interleaved-thinking-2025-05-14' }),
  });
  expect(result.headers.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14,context-management-2025-06-27');
});
