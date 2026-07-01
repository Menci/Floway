import { test } from 'vitest';

import { withContextManagementBetaAligned } from './align-context-management-beta.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload & { context_management?: unknown }, headers: Headers = new Headers()): MessagesBoundaryCtx => ({
  payload: payload as MessagesPayload,
  headers,
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const baseBody = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('attaches the beta token when the payload has context_management and the header is missing', async () => {
  const ctx = invocation({ ...baseBody, context_management: { edits: [] } });

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'context-management-2025-06-27');
});

test('appends the beta token alongside other allow-listed values', async () => {
  const ctx = invocation(
    { ...baseBody, context_management: { edits: [] } },
    new Headers({ 'anthropic-beta': 'interleaved-thinking-2025-05-14' }),
  );

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

test('leaves the header untouched when the beta token is already present', async () => {
  const ctx = invocation(
    { ...baseBody, context_management: { edits: [] } },
    new Headers({ 'anthropic-beta': 'interleaved-thinking-2025-05-14,context-management-2025-06-27' }),
  );

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

test('does not duplicate the beta token when surrounding whitespace differs', async () => {
  const ctx = invocation(
    { ...baseBody, context_management: { edits: [] } },
    new Headers({ 'anthropic-beta': ' context-management-2025-06-27 , interleaved-thinking-2025-05-14 ' }),
  );

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  // Token is already present (post-trim); the interceptor leaves the
  // header untouched. Note `Headers` trims the value's outer whitespace on
  // ingest, so the stored value is what `Headers.get` returns here, not the
  // literal we passed in.
  assertEquals(ctx.headers.get('anthropic-beta'), 'context-management-2025-06-27 , interleaved-thinking-2025-05-14');
});

test('does not modify the header when the payload does not carry context_management', async () => {
  const ctx = invocation(
    baseBody,
    new Headers({ 'anthropic-beta': 'interleaved-thinking-2025-05-14' }),
  );

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
});

test('does not introduce the header when the payload does not carry context_management and no header was set', async () => {
  const ctx = invocation(baseBody);

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('anthropic-beta'), false);
});
