import { test } from 'vitest';

import { hoistUserSystemToMessages } from '../../../src/interceptors/anthropic-messages/hoist-user-system-to-messages.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const okEvents = (): Promise<ProviderStreamResult<AnthropicMessagesStreamEventEx>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesBoundaryCtx => ({
  payload,
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
  upstreamId: 'up_test',
});

test('captures a string system into a synthetic user/assistant pair and drops `system`', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'real question' }],
    system: 'You are a pirate.',
  });

  await hoistUserSystemToMessages(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages, [
    { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nYou are a pirate.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will follow these instructions.' }] },
    { role: 'user', content: 'real question' },
  ]);
});

test('drops system but does not inject a synthetic turn when system text is empty', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: '' }],
  });

  await hoistUserSystemToMessages(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages.length, 1);
});
