import { expect, test } from 'vitest';

import { addIdentityBlock } from '../../../src/pipelines/anthropic-messages/inject-identity-block.ts';
import { IDENTITY_BLOCK } from '../../../src/pipelines/anthropic-messages/system-blocks.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const payload = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hello' }],
} satisfies AnthropicMessagesPayload;

test('appends the Claude Code identity after the billing block', () => {
  const billing = { type: 'text', text: 'x-anthropic-billing-header:' } as const;
  expect(addIdentityBlock({ ...payload, system: [billing] }).system).toEqual([billing, IDENTITY_BLOCK]);
});

test('fails when the billing block was not materialized', () => {
  expect(() => addIdentityBlock(payload)).toThrow(TypeError);
});
