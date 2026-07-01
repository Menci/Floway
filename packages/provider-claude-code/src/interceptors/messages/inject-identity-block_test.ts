import { test } from 'vitest';

import { injectIdentityBlock } from './inject-identity-block.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { IDENTITY_BLOCK } from '../../system-blocks.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const okEvents = (): Promise<ProviderStreamResult<MessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: MessagesPayload): ClaudeCodeMessagesBoundaryCtx => ({
  payload,
  model: stubProviderModel({ endpoints: { messages: {} } }),
  upstreamId: 'up_test',
});

test('appends IDENTITY_BLOCK after an existing system[0] block', async () => {
  const billing = { type: 'text' as const, text: 'x-anthropic-billing-header: cc_version=2.1.181.abc;' };
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [billing],
  });

  await injectIdentityBlock(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, [billing, IDENTITY_BLOCK]);
});

test('appends IDENTITY_BLOCK onto a one-block system array regardless of block content', async () => {
  const existing = { type: 'text' as const, text: 'placeholder' };
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [existing],
  });

  await injectIdentityBlock(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, [existing, IDENTITY_BLOCK]);
});
