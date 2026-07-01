import { test } from 'vitest';

import { withToolStrictStripped } from './strip-tool-strict.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

test('strips strict from client tools while preserving the rest', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { name: 'a', input_schema: { type: 'object' }, strict: true },
      { name: 'b', description: 'keep me', input_schema: { type: 'object', properties: {} } },
    ],
  });

  await withToolStrictStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.tools, [
    { name: 'a', input_schema: { type: 'object' } },
    { name: 'b', description: 'keep me', input_schema: { type: 'object', properties: {} } },
  ]);
});

test('no-op when payload has no tools', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await withToolStrictStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.tools, undefined);
});
