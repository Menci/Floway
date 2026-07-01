import { test } from 'vitest';

import { withInterleavedSystemDemotedToUser } from './demote-interleaved-system-to-user.ts';
import type { ChatCompletionsInvocation } from './types.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventResult } from '@floway-dev/provider';
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

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (
  payload: ChatCompletionsPayload,
  enabledFlags: ReadonlySet<string> = new Set(['demote-interleaved-system-to-user']),
): ChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'chat-completions',
  headers: new Headers(),
});

test('leaves the payload untouched when the flag is not set', async () => {
  const messages = [
    { role: 'system' as const, content: 'sys-a' },
    { role: 'user' as const, content: 'hi' },
    { role: 'system' as const, content: 'sys-b' },
  ];
  const input = invocation({ model: 'm', messages: messages.map(m => ({ ...m })) }, new Set());

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, messages);
});

test('keeps the leading contiguous system run intact when no non-system follows', async () => {
  const messages = [
    { role: 'system' as const, content: 'sys-a' },
    { role: 'system' as const, content: 'sys-b' },
    { role: 'system' as const, content: 'sys-c' },
  ];
  const input = invocation({ model: 'm', messages: messages.map(m => ({ ...m })) });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, messages);
});

test('preserves the leading system run and demotes every later system message to user', async () => {
  const input = invocation({
    model: 'm',
    messages: [
      { role: 'system', content: 'sys-a' },
      { role: 'system', content: 'sys-b' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'mid-conversation sys' },
      { role: 'assistant', content: 'sure' },
      { role: 'system', content: 'late sys' },
    ],
  });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, [
    { role: 'system', content: 'sys-a' },
    { role: 'system', content: 'sys-b' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'mid-conversation sys' },
    { role: 'assistant', content: 'sure' },
    { role: 'user', content: 'late sys' },
  ]);
});

test('preserves multi-part content verbatim when demoting', async () => {
  const parts = [
    { type: 'text' as const, text: 'one' },
    { type: 'text' as const, text: 'two' },
  ];
  const input = invocation({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: parts },
    ],
  });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, [
    { role: 'user', content: 'hi' },
    { role: 'user', content: parts },
  ]);
});

test('is a no-op for an empty messages array', async () => {
  const input = invocation({ model: 'm', messages: [] });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.messages, []);
});
