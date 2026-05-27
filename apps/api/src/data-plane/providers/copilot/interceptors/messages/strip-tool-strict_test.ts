import { test } from 'vitest';

import { withToolStrictStripped } from './strip-tool-strict.ts';
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

const invocation = (payload: MessagesPayload): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
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
