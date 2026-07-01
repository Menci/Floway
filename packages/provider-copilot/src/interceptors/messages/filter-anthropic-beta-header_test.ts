import { test } from 'vitest';

import { withAnthropicBetaHeaderFiltered } from './filter-anthropic-beta-header.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload, anthropicBeta?: readonly string[]): MessagesBoundaryCtx => {
  const headers = new Headers();
  if (anthropicBeta !== undefined) headers.set('anthropic-beta', anthropicBeta.join(','));
  return {
    payload,
    headers,
    model: stubProviderModel({ endpoints: { messages: {} } }),
  };
};

test('keeps only allow-listed anthropic-beta values when caller supplied a header', async () => {
  const ctx = invocation(
    { model: 'claude-test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    ['interleaved-thinking-2025-05-14', 'unknown-beta', 'context-management-2025-06-27'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

test('forwards inbound interleaved-thinking unchanged when paired with non-adaptive budget thinking', async () => {
  const ctx = invocation(
    {
      model: 'claude-test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    },
    ['interleaved-thinking-2025-05-14'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
});

test('respects the caller and does NOT auto-add interleaved-thinking when caller supplied only other betas', async () => {
  const ctx = invocation(
    {
      model: 'claude-test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    },
    ['context-management-2025-06-27'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  // Even though non-adaptive thinking + budget_tokens would auto-add
  // interleaved in the no-inbound branch, the caller already expressed
  // intent by sending its own anthropic-beta header. Match VSCode behavior:
  // do not silently inflate the caller's beta set.
  assertEquals(ctx.headers.get('anthropic-beta'), 'context-management-2025-06-27');
});

test('keeps inbound interleaved-thinking even when adaptive thinking is requested', async () => {
  // caozhiyuan's buildAnthropicBetaHeader only filters against the allow-list
  // on the inbound branch; it never drops interleaved on adaptive thinking.
  // We match that behavior rather than carrying a private exclusion rule.
  const ctx = invocation(
    {
      model: 'claude-test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    },
    ['interleaved-thinking-2025-05-14', 'context-management-2025-06-27'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

test('auto-adds interleaved-thinking when caller sent no header and budget_tokens is set without adaptive thinking', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
});

test('does not auto-add interleaved-thinking when caller sent no header and thinking is adaptive', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive', budget_tokens: 1024 },
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('anthropic-beta'), false);
});

test('does not set the header when the inbound caller header has nothing allow-listed', async () => {
  const ctx = invocation(
    { model: 'claude-test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    ['unknown-beta-only'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('anthropic-beta'), false);
});

test('does not set the header when no anthropic-beta input is present and thinking is not configured', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('anthropic-beta'), false);
});
