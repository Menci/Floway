import { test } from 'vitest';

import { withAnthropicBetaNormalized } from '../../../src/interceptors/messages/normalize-anthropic-beta.ts';
import type { MessagesBoundaryCtx } from '../../../src/interceptors/messages/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, type ExecuteResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};
const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (
  payload: MessagesPayload & { context_management?: unknown },
  anthropicBeta: string[] = [],
): MessagesBoundaryCtx => ({
  payload: payload as MessagesPayload,
  headers: new Headers(),
  anthropicBeta,
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const baseBody = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('keeps only supported caller beta values in first-seen order', async () => {
  const ctx = invocation(baseBody, [
    'advanced-tool-use-2025-11-20',
    'unknown-beta',
    'advanced-tool-use-2025-11-20',
    'context-1m-2025-08-07',
  ]);
  await withAnthropicBetaNormalized(ctx, stubRequest, okEvents);
  assertEquals(ctx.anthropicBeta, ['advanced-tool-use-2025-11-20']);
});

test('synthesizes interleaved thinking only when the caller supplied no beta intent', async () => {
  const payload = { ...baseBody, thinking: { type: 'enabled' as const, budget_tokens: 1024 } };
  const silent = invocation(payload);
  const explicit = invocation(payload, ['context-1m-2025-08-07']);
  await withAnthropicBetaNormalized(silent, stubRequest, okEvents);
  await withAnthropicBetaNormalized(explicit, stubRequest, okEvents);
  assertEquals(silent.anthropicBeta, ['interleaved-thinking-2025-05-14']);
  assertEquals(explicit.anthropicBeta, []);
});

test('does not synthesize interleaved thinking for adaptive thinking', async () => {
  const ctx = invocation({ ...baseBody, thinking: { type: 'adaptive', budget_tokens: 1024 } });
  await withAnthropicBetaNormalized(ctx, stubRequest, okEvents);
  assertEquals(ctx.anthropicBeta, []);
});

test('pairs context management with its required beta token', async () => {
  const ctx = invocation(
    { ...baseBody, context_management: { edits: [] } },
    ['interleaved-thinking-2025-05-14'],
  );
  await withAnthropicBetaNormalized(ctx, stubRequest, okEvents);
  assertEquals(ctx.anthropicBeta, [
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
  ]);
});
