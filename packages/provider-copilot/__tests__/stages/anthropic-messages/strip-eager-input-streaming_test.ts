import { expect, test } from 'vitest';

import { copilotAnthropicMessagesStripEagerInputStreaming } from '../../../src/stages/anthropic-messages/strip-eager-input-streaming.ts';
import { applyProviderStage, stubProviderModel } from '@floway-dev/test-utils';

test('removes eager_input_streaming while preserving unaffected tool identity and the immutable input', async () => {
  const kept = { name: 'kept', input_schema: { type: 'object' as const, properties: {} } };
  const removed = { name: 'changed', input_schema: { type: 'object' as const, properties: {} }, eager_input_streaming: true };
  const payload = { model: 'claude', max_tokens: 16, messages: [], tools: [kept, removed] };
  const probe = { payload, headers: new Headers(), anthropicBeta: [], model: stubProviderModel() };
  await applyProviderStage(copilotAnthropicMessagesStripEagerInputStreaming, probe, async () => {});
  expect(probe.payload.tools[0]).toBe(kept);
  expect(probe.payload.tools[1]).not.toBe(removed);
  expect(probe.payload.tools[1]).not.toHaveProperty('eager_input_streaming');
  expect(payload.tools[1]).toBe(removed);
  expect(removed.eager_input_streaming).toBe(true);
});
