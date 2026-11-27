import { test } from 'vitest';

import { hoistUserSystemToMessages } from '../../../src/interceptors/anthropic-messages/hoist-user-system-to-messages.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';
import type { UpstreamStreamResult } from '@floway-dev/upstream';

const okEvents = (): Promise<UpstreamStreamResult<AnthropicMessagesStreamEventEx>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesBoundaryCtx => ({
  payload,
  model: stubUpstreamModel({ endpoints: { anthropicMessages: {} } }),
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
