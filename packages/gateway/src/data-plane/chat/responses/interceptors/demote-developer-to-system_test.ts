import { test } from 'vitest';

import { withDemoteDeveloperToSystem } from './demote-developer-to-system.ts';
import type { ResponsesInvocation } from './types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: GatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
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

const invocation = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['demote-developer-to-system'])): ResponsesInvocation => ({
  payload,
  candidate: stubProviderCandidate({ model: { enabledFlags } }),
  targetApi: 'responses',
  store: new LayeredStatefulResponsesStore({
    apiKeyId: 'test-key',
    reads: [new MemoryStatefulResponsesBacking()],
    itemWrites: [],
    snapshotWrites: [],
    stageInputs: false,
  }),
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

test('passes string input through unchanged', async () => {
  const input = invocation({
    model: 'deepseek-chat',
    input: 'hello world',
  });

  const original = input.payload;
  await withDemoteDeveloperToSystem(input, stubCtx, okEvents);

  assertEquals(input.payload, original);
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
