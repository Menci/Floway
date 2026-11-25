import { test } from 'vitest';

import { withDefaultTemplate } from '../../../src/pipelines/anthropic-messages/inject-default-template.ts';
import { DEFAULT_TEMPLATE_BLOCK, IDENTITY_BLOCK } from '../../../src/pipelines/anthropic-messages/system-blocks.ts';
import type { AnthropicMessagesClientTool, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const billingBlock: AnthropicMessagesTextBlockParam = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.abc;' };

test('preserves ephemeral cache_control when caller already holds 3 breakpoints (total 4 = cap)', () => {
  const cachedTool: AnthropicMessagesClientTool = {
    name: 'lookup',
    input_schema: { type: 'object' },
    cache_control: { type: 'ephemeral' },
  };
  const cachedSystemBlock: AnthropicMessagesTextBlockParam = {
    citations: null,
    type: 'text',
    text: 'caller-supplied cached system fragment',
    cache_control: { type: 'ephemeral' },
  };
  const cachedUserBlock: AnthropicMessagesTextBlockParam = {
    citations: null,
    type: 'text',
    text: 'cached prior turn',
    cache_control: { type: 'ephemeral' },
  };
  const payload = withDefaultTemplate({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: [cachedUserBlock, { type: 'text', text: 'hi' }] }],
    system: [billingBlock, IDENTITY_BLOCK, cachedSystemBlock],
    tools: [cachedTool],
  });

  if (!Array.isArray(payload.system)) throw new Error('expected system to be an array');
  assertEquals(payload.system.length, 4);
  assertEquals(payload.system[3], DEFAULT_TEMPLATE_BLOCK);
  assertEquals(payload.system[3]!.cache_control, { type: 'ephemeral', ttl: '5m' });
});

test('demotes our cache_control when caller already holds 4 breakpoints (would be 5)', () => {
  const cachedTool: AnthropicMessagesClientTool = {
    name: 'lookup',
    input_schema: { type: 'object' },
    cache_control: { type: 'ephemeral' },
  };
  const cachedSystemBlock: AnthropicMessagesTextBlockParam = {
    citations: null,
    type: 'text',
    text: 'caller-supplied cached system fragment',
    cache_control: { type: 'ephemeral' },
  };
  const cachedUserBlockA: AnthropicMessagesTextBlockParam = {
    citations: null,
    type: 'text',
    text: 'cached turn A',
    cache_control: { type: 'ephemeral' },
  };
  const cachedUserBlockB: AnthropicMessagesTextBlockParam = {
    citations: null,
    type: 'text',
    text: 'cached turn B',
    cache_control: { type: 'ephemeral' },
  };
  const payload = withDefaultTemplate({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: [cachedUserBlockA, cachedUserBlockB, { type: 'text', text: 'hi' }] }],
    system: [billingBlock, IDENTITY_BLOCK, cachedSystemBlock],
    tools: [cachedTool],
  });

  if (!Array.isArray(payload.system)) throw new Error('expected system to be an array');
  assertEquals(payload.system.length, 4);
  const injected = payload.system[3]!;
  assertEquals(injected.text, DEFAULT_TEMPLATE_BLOCK.text);
  assertEquals(injected.cache_control, undefined);
});
