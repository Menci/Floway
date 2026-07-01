import { test } from 'vitest';

import { withDemoteDeveloperToSystem } from './demote-developer-to-system.ts';
import type { ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

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

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (payload: CanonicalResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['demote-developer-to-system'])): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

test('rewrites developer role to system on input messages', async () => {
  const input = invocation({
    model: 'deepseek-chat',
    input: [
      { type: 'message', role: 'developer', content: 'You are a helpful assistant.' },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  });

  await withDemoteDeveloperToSystem(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string; content: unknown }>;
  assertEquals(items[0].role, 'system');
  assertEquals(items[1].role, 'user');
});

test('leaves system role untouched on input messages', async () => {
  const input = invocation({
    model: 'deepseek-chat',
    input: [
      { type: 'message', role: 'system', content: 'You are a helpful assistant.' },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  });

  await withDemoteDeveloperToSystem(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string }>;
  assertEquals(items[0].role, 'system');
});

test('leaves non-message input items untouched', async () => {
  const input = invocation({
    model: 'deepseek-chat',
    input: [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      { type: 'message', role: 'developer', content: 'instructions' },
    ],
  });

  await withDemoteDeveloperToSystem(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ type: string; role?: string }>;
  assertEquals(items[0].type, 'message');
  assertEquals(items[0].role, 'user');
  assertEquals(items[1].type, 'function_call_output');
  assertEquals(items[2].role, 'system');
});

test('early-returns when flag is not set', async () => {
  const input = invocation(
    {
      model: 'deepseek-chat',
      input: [
        { type: 'message', role: 'developer', content: 'instructions' },
      ],
    },
    new Set(),
  );

  await withDemoteDeveloperToSystem(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string }>;
  assertEquals(items[0].role, 'developer');
});
