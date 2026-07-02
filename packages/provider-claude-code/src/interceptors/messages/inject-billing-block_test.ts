import { test } from 'vitest';

import { injectBillingBlock } from './inject-billing-block.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { CLAUDE_CLI_VERSION } from '../../headers.ts';
import type { MessagesPayload, MessagesStreamEvent, MessagesTextBlock } from '@floway-dev/protocols/messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const okEvents = (): Promise<ProviderStreamResult<MessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: MessagesPayload): ClaudeCodeMessagesBoundaryCtx => ({
  payload,
  model: stubProviderModel({ endpoints: { messages: {} } }),
  upstreamId: 'up_test',
});

test('drops a single billing block as system[0] with the pinned CLI version and a 3-hex fingerprint', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello world' }],
  });

  await injectBillingBlock(ctx, {}, okEvents);

  const system = ctx.payload.system;
  if (!Array.isArray(system)) throw new Error('expected system to be an array');
  assertEquals(system.length, 1);
  const [block] = system;
  assertEquals(block!.type, 'text');
  const fp = block!.text.match(/cc_version=([\d.]+)\.([0-9a-f]{3});/);
  if (!fp) throw new Error(`expected billing text to embed version.fingerprint, got: ${block!.text}`);
  assertEquals(fp[1], CLAUDE_CLI_VERSION);
  // cch=00000 is a literal in the wire shape, not a client-computed hash.
  assertEquals(block!.text.endsWith('cch=00000;'), true);
  assertEquals(block!.text.startsWith('x-anthropic-billing-header: '), true);
});

test('overwrites any pre-existing system array (hoist already ran)', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: 'stale leftover' } satisfies MessagesTextBlock],
  });

  await injectBillingBlock(ctx, {}, okEvents);

  const system = ctx.payload.system;
  if (!Array.isArray(system)) throw new Error('expected system to be an array');
  assertEquals(system.length, 1);
  assertEquals(system[0]!.text.startsWith('x-anthropic-billing-header: '), true);
});
