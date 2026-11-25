import { test } from 'vitest';

import { withSystemInMessages } from '../../../src/pipelines/anthropic-messages/hoist-user-system-to-messages.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('captures a string system into a synthetic user/assistant pair and drops `system`', () => {
  const payload = withSystemInMessages({
    model: 'claude-test',
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
