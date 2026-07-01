import { test } from 'vitest';

import { withDemoteDeveloperToSystem } from './demote-developer-to-system.ts';
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

const invocation = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set(['demote-developer-to-system'])): ChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'chat-completions',
  headers: new Headers(),
});

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

test('rewrites developer role to system on messages', async () => {
  const ctx = invocation({
    model: 'deepseek-chat',
    messages: [
      { role: 'developer', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withDemoteDeveloperToSystem(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'system');
  assertEquals(observed!.messages[1].role, 'user');
});

test('leaves system role untouched', async () => {
  const ctx = invocation({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withDemoteDeveloperToSystem(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'system');
  assertEquals(observed!.messages[0].content, 'You are a helpful assistant.');
});

test('leaves assistant and tool roles untouched', async () => {
  const ctx = invocation({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withDemoteDeveloperToSystem(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'user');
  assertEquals(observed!.messages[1].role, 'assistant');
  assertEquals(observed!.messages[2].role, 'tool');
});

test('early-returns when flag is not set', async () => {
  const ctx = invocation(
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'developer', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hello' },
      ],
    },
    new Set(),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withDemoteDeveloperToSystem(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'developer');
});

test('handles mixed roles with multiple developer messages', async () => {
  const ctx = invocation({
    model: 'deepseek-chat',
    messages: [
      { role: 'developer', content: 'first developer message' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'developer', content: 'second developer message' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withDemoteDeveloperToSystem(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'system');
  assertEquals(observed!.messages[3].role, 'system');
  assertEquals(observed!.messages[0].content, 'first developer message');
  assertEquals(observed!.messages[3].content, 'second developer message');
});
