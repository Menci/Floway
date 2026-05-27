import { test } from 'vitest';

import { withAnthropicBetaHeaderFiltered } from './filter-anthropic-beta-header.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload, anthropicBeta?: readonly string[]): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
  ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
});

test('keeps only allow-listed anthropic-beta values when caller supplied a header', async () => {
  const ctx = invocation(
    { model: 'claude-test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    ['interleaved-thinking-2025-05-14', 'unknown-beta', 'context-management-2025-06-27'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
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

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
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
  assertEquals(ctx.headers['anthropic-beta'], 'context-management-2025-06-27');
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

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

test('auto-adds interleaved-thinking when caller sent no header and budget_tokens is set without adaptive thinking', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
});

test('does not auto-add interleaved-thinking when caller sent no header and thinking is adaptive', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive', budget_tokens: 1024 },
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});

test('does not set the header when the inbound caller header has nothing allow-listed', async () => {
  const ctx = invocation(
    { model: 'claude-test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    ['unknown-beta-only'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});

test('does not set the header when no anthropic-beta input is present and thinking is not configured', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});
