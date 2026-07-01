import { test } from 'vitest';

import { demoteInterleavedSystemToUser } from './demote-interleaved-system-to-user.ts';
import type { MessagesInvocation } from './types.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

interface InvocationOptions {
  flagOn?: boolean;
}

const invocation = (payload: MessagesPayload, { flagOn = true }: InvocationOptions = {}): MessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({
    model: { endpoints: { messages: {} } },
    enabledFlags: flagOn ? new Set(['demote-interleaved-system-to-user']) : new Set(),
  }),
  targetApi: 'messages',
  headers: new Headers(),
});

test('leaves the payload untouched when the flag is off', async () => {
  const messages = [
    { role: 'system' as const, content: 'sys-a' },
    { role: 'user' as const, content: 'hello' },
    { role: 'system' as const, content: 'sys-b' },
  ];
  const input = invocation(
    { model: 'm', max_tokens: 1, messages: messages.map(m => ({ ...m })) },
    { flagOn: false },
  );

  await demoteInterleavedSystemToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, messages);
});

test('demotes every inline system message because payload.system is the first-position slot', async () => {
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    system: 'top-level sys',
    messages: [
      { role: 'system', content: 'leading inline sys' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'later sys' },
    ],
  });

  await demoteInterleavedSystemToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, [
    { role: 'user', content: 'leading inline sys' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'later sys' },
  ]);
});

test('preserves array content verbatim when demoting', async () => {
  const blocks = [
    { type: 'text' as const, text: 'one' },
    { type: 'text' as const, text: 'two' },
  ];
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: blocks },
    ],
  });

  await demoteInterleavedSystemToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, [
    { role: 'user', content: 'hi' },
    { role: 'user', content: blocks },
  ]);
});

test('is a no-op for an empty messages array', async () => {
  const input = invocation({ model: 'm', max_tokens: 1, messages: [] });

  await demoteInterleavedSystemToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, []);
});

test('leaves a payload without any inline system messages untouched', async () => {
  const messages = [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
    { role: 'user' as const, content: 'how' },
  ];
  const input = invocation({ model: 'm', max_tokens: 1, messages: messages.map(m => ({ ...m })) });

  await demoteInterleavedSystemToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, messages);
});
