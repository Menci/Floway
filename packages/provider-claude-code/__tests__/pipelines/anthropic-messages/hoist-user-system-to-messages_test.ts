import { expect, test } from 'vitest';

import { hoistSystem } from '../../../src/pipelines/anthropic-messages/hoist-user-system-to-messages.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const payload = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'real question' }],
} satisfies AnthropicMessagesPayload;

test('moves the text of system blocks into a balanced user/assistant pair', () => {
  const updated = hoistSystem({
    ...payload,
    system: [
      { type: 'text', text: 'First instruction', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '' },
      { type: 'text', text: 'Second instruction' },
    ],
  });
  expect(Object.hasOwn(updated, 'system')).toBe(false);
  expect(updated.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nFirst instruction\n\nSecond instruction' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will follow these instructions.' }] },
    ...payload.messages,
  ]);
});

test('leaves the conversation intact when the system has no text', () => {
  expect(hoistSystem({ ...payload, system: [{ type: 'text', text: '' }] })).toEqual(payload);
});
