import { test } from 'vitest';

import { injectIdentityBlock } from '../../src/stages/inject-identity-block.ts';
import { IDENTITY_BLOCK } from '../../src/system-blocks.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import type { AnthropicMessagesProbe } from '@floway-dev/test-utils';
import { applyProviderStage, assertEquals, stubProviderModel } from '@floway-dev/test-utils';

type ClaudeCodeStageProbe = AnthropicMessagesProbe & { upstreamId: string };

const okEvents = (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: AnthropicMessagesPayload): ClaudeCodeStageProbe => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
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

  await applyProviderStage(injectIdentityBlock, ctx, okEvents, { 'request.claudeCode.shaped': false });

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

  await applyProviderStage(injectIdentityBlock, ctx, okEvents, { 'request.claudeCode.shaped': false });

  assertEquals(ctx.payload.system, [existing, IDENTITY_BLOCK]);
});
