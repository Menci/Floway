import { test } from 'vitest';

import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import type { ChatCompletionsBoundaryCtx } from './types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ChatCompletionsPayload): ChatCompletionsBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { chatCompletions: {} } }),
});

test('Chat Completions initiator is user when the last message is from the user', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
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

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
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

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});
