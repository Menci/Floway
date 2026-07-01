import { test } from 'vitest';

import { injectDefaultTemplate } from './inject-default-template.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { DEFAULT_TEMPLATE_BLOCK, IDENTITY_BLOCK } from '../../system-blocks.ts';
import type { MessagesClientTool, MessagesPayload, MessagesStreamEvent, MessagesTextBlock } from '@floway-dev/protocols/messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const okEvents = (): Promise<ProviderStreamResult<MessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: MessagesPayload): ClaudeCodeMessagesBoundaryCtx => ({
  payload,
  model: stubProviderModel({ endpoints: { messages: {} } }),
  upstreamId: 'up_test',
});

const billingBlock: MessagesTextBlock = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.181.abc;' };

test('appends DEFAULT_TEMPLATE_BLOCK as system[2] with ephemeral cache_control intact', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [billingBlock, IDENTITY_BLOCK],
  });

  await injectDefaultTemplate(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, [billingBlock, IDENTITY_BLOCK, DEFAULT_TEMPLATE_BLOCK]);
  if (!Array.isArray(ctx.payload.system)) throw new Error('expected system to be an array');
  assertEquals(ctx.payload.system[2]!.cache_control, { type: 'ephemeral', ttl: '5m' });
});

test('preserves ephemeral cache_control when caller already holds 3 breakpoints (total 4 = cap)', async () => {
  const cachedTool: MessagesClientTool = {
    name: 'lookup',
    input_schema: { type: 'object' },
    cache_control: { type: 'ephemeral' },
  };
  const cachedSystemBlock: MessagesTextBlock = {
    type: 'text',
    text: 'caller-supplied cached system fragment',
    cache_control: { type: 'ephemeral' },
  };
  const cachedUserBlock: MessagesTextBlock = {
    type: 'text',
    text: 'cached prior turn',
    cache_control: { type: 'ephemeral' },
  };
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: [cachedUserBlock, { type: 'text', text: 'hi' }] }],
    system: [billingBlock, IDENTITY_BLOCK, cachedSystemBlock],
    tools: [cachedTool],
  });

  await injectDefaultTemplate(ctx, {}, okEvents);

  if (!Array.isArray(ctx.payload.system)) throw new Error('expected system to be an array');
  assertEquals(ctx.payload.system.length, 4);
  assertEquals(ctx.payload.system[3], DEFAULT_TEMPLATE_BLOCK);
  assertEquals(ctx.payload.system[3]!.cache_control, { type: 'ephemeral', ttl: '5m' });
});

test('demotes our cache_control when caller already holds 4 breakpoints (would be 5)', async () => {
  const cachedTool: MessagesClientTool = {
    name: 'lookup',
    input_schema: { type: 'object' },
    cache_control: { type: 'ephemeral' },
  };
  const cachedSystemBlock: MessagesTextBlock = {
    type: 'text',
    text: 'caller-supplied cached system fragment',
    cache_control: { type: 'ephemeral' },
  };
  const cachedUserBlockA: MessagesTextBlock = {
    type: 'text',
    text: 'cached turn A',
    cache_control: { type: 'ephemeral' },
  };
  const cachedUserBlockB: MessagesTextBlock = {
    type: 'text',
    text: 'cached turn B',
    cache_control: { type: 'ephemeral' },
  };
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: [cachedUserBlockA, cachedUserBlockB, { type: 'text', text: 'hi' }] }],
    system: [billingBlock, IDENTITY_BLOCK, cachedSystemBlock],
    tools: [cachedTool],
  });

  await injectDefaultTemplate(ctx, {}, okEvents);

  if (!Array.isArray(ctx.payload.system)) throw new Error('expected system to be an array');
  assertEquals(ctx.payload.system.length, 4);
  const injected = ctx.payload.system[3]!;
  assertEquals(injected.text, DEFAULT_TEMPLATE_BLOCK.text);
  assertEquals(injected.cache_control, undefined);
});

test('demotes our cache_control when caller already exceeds the cap', async () => {
  const cachedTool: MessagesClientTool = {
    name: 'lookup',
    input_schema: { type: 'object' },
    cache_control: { type: 'ephemeral' },
  };
  const cachedBlock = (text: string): MessagesTextBlock => ({
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  });
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [
      { role: 'user', content: [cachedBlock('a'), cachedBlock('b'), cachedBlock('c'), { type: 'text', text: 'hi' }] },
    ],
    system: [billingBlock, IDENTITY_BLOCK, cachedBlock('d'), cachedBlock('e')],
    tools: [cachedTool],
  });

  await injectDefaultTemplate(ctx, {}, okEvents);

  if (!Array.isArray(ctx.payload.system)) throw new Error('expected system to be an array');
  const injected = ctx.payload.system.at(-1)!;
  assertEquals(injected.text, DEFAULT_TEMPLATE_BLOCK.text);
  assertEquals(injected.cache_control, undefined);
});
