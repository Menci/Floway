import { test } from 'vitest';

import { hoistUserSystemToMessages } from '../../../src/stages/anthropic-messages/hoist-user-system-to-messages.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('captures a string system into a synthetic user/assistant pair and drops `system`', () => {
  const payload = hoistUserSystemToMessages({
    max_tokens: 16,
    messages: [{ role: 'user', content: 'real question' }],
    system: 'You are a pirate.',
  });

  assertEquals(payload.system, undefined);
  assertEquals(payload.messages, [
    { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nYou are a pirate.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will follow these instructions.' }] },
    { role: 'user', content: 'real question' },
  ]);
});
