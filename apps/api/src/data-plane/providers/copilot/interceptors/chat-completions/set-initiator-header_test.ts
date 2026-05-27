import { test } from 'vitest';

import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { ChatCompletionsInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionChunk>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ChatCompletionsPayload): ChatCompletionsInvocation => ({
  sourceApi: 'chat-completions',
  targetApi: 'chat-completions',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('Chat Completions initiator is user when the last message is from the user', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Chat Completions initiator is agent when the last message is an assistant replay', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'previous answer' },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'agent');
});

test('Chat Completions initiator is agent when the last message is a tool result', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'do_thing', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'agent');
});
