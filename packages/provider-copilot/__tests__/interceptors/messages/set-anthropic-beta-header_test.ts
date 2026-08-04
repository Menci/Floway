import { test } from 'vitest';

import { withAnthropicBetaHeaderSet } from '../../../src/interceptors/messages/set-anthropic-beta-header.ts';
import type { MessagesBoundaryCtx } from '../../../src/interceptors/messages/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, type ExecuteResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload & { context_management?: unknown }): MessagesBoundaryCtx => ({
  payload: payload as MessagesPayload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const baseBody = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('sets no beta for a plain Messages payload', async () => {
  const ctx = invocation(baseBody);
  await withAnthropicBetaHeaderSet(ctx, stubRequest, okEvents);
  assertEquals(ctx.headers.has('anthropic-beta'), false);
});

test('sets interleaved thinking for non-adaptive budget thinking', async () => {
  const ctx = invocation({ ...baseBody, thinking: { type: 'enabled', budget_tokens: 1024 } });
  await withAnthropicBetaHeaderSet(ctx, stubRequest, okEvents);
  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
});

test('does not set interleaved thinking for adaptive thinking', async () => {
  const ctx = invocation({ ...baseBody, thinking: { type: 'adaptive', budget_tokens: 1024 } });
  await withAnthropicBetaHeaderSet(ctx, stubRequest, okEvents);
  assertEquals(ctx.headers.has('anthropic-beta'), false);
});

test('sets context management for its matching payload field', async () => {
  const ctx = invocation({ ...baseBody, context_management: { edits: [] } });
  await withAnthropicBetaHeaderSet(ctx, stubRequest, okEvents);
  assertEquals(ctx.headers.get('anthropic-beta'), 'context-management-2025-06-27');
});

test('sets both betas in canonical order when both payload features are active', async () => {
  const ctx = invocation({
    ...baseBody,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    context_management: { edits: [] },
  });
  await withAnthropicBetaHeaderSet(ctx, stubRequest, okEvents);
  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});
