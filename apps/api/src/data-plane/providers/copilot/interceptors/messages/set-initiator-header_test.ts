import { test } from 'vitest';

import { withInitiatorHeaderSet } from './set-initiator-header.ts';
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

test('Messages initiator is user when the last message is a plain user turn', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hello' }],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Messages initiator is user when the last user turn mixes text and tool_result', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't_1', content: [{ type: 'text', text: 'result' }] },
          { type: 'text', text: 'follow-up question' },
        ],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Messages initiator is agent when the last user turn is entirely tool_result blocks', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't_1', content: [{ type: 'text', text: 'result' }] },
        ],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'agent');
});

test('Messages initiator is agent when the final message is from the assistant', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'agent');
});
