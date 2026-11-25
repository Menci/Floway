import { expect, test } from 'vitest';

import { addDefaultTemplate } from '../../../src/pipelines/anthropic-messages/inject-default-template.ts';
import { DEFAULT_TEMPLATE_BLOCK, IDENTITY_BLOCK } from '../../../src/pipelines/anthropic-messages/system-blocks.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';

const cache = { type: 'ephemeral' } as const;
const cachedText = (text: string): AnthropicMessagesTextBlockParam => ({ type: 'text', text, cache_control: cache });
const billing = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.abc;' } as const;
const payload = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 16,
  messages: [{ role: 'user', content: [cachedText('cached prior turn'), { type: 'text', text: 'hello' }] }],
  system: [billing, IDENTITY_BLOCK, cachedText('caller system fragment')],
  tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: cache }],
} satisfies AnthropicMessagesPayload;

test('keeps the template cache breakpoint when the caller uses three', () => {
  expect(addDefaultTemplate(payload).system).toEqual([...payload.system, DEFAULT_TEMPLATE_BLOCK]);
});

test('appends an uncached template when the caller uses all four breakpoints', () => {
  const updated = addDefaultTemplate({
    ...payload,
    messages: [...payload.messages, { role: 'assistant', content: [cachedText('cached reply')] }],
  });
  expect(updated.system).toEqual([...payload.system, { type: 'text', text: DEFAULT_TEMPLATE_BLOCK.text }]);
});

test('fails when the earlier stages did not materialize system blocks', () => {
  expect(() => addDefaultTemplate({ ...payload, system: 'caller system prompt' })).toThrow(TypeError);
});
