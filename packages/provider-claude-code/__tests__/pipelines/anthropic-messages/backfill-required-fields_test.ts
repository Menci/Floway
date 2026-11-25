import { expect, test } from 'vitest';

import { fillFields } from '../../../src/pipelines/anthropic-messages/backfill-required-fields.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const payload = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
} satisfies AnthropicMessagesPayload;

test('uses the advertised model limit for an omitted token budget', () => {
  const { max_tokens: _maxTokens, ...omittedLimit } = payload;
  expect(fillFields(omittedLimit as AnthropicMessagesPayload, 64_000)).toMatchObject({
    max_tokens: 64_000,
    temperature: 1,
  });
  expect(fillFields(omittedLimit as AnthropicMessagesPayload, undefined).max_tokens).toBe(ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS);
});

test('keeps the supplied token budget and temperature including zero', () => {
  expect(fillFields({ ...payload, temperature: 0 }, 64_000)).toMatchObject({ max_tokens: 1024, temperature: 0 });
});
