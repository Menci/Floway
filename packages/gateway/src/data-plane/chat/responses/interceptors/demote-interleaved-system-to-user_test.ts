import { test } from 'vitest';

import { withInterleavedSystemDemotedToUser } from './demote-interleaved-system-to-user.ts';
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

const invocation = (
  payload: ResponsesPayload,
  enabledFlags: ReadonlySet<string> = new Set(['demote-interleaved-system-to-user']),
): ResponsesInvocation => ({
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

test('leaves the payload untouched when the flag is not set', async () => {
  const input_ = [
    { type: 'message' as const, role: 'system' as const, content: 'sys-a' },
    { type: 'message' as const, role: 'user' as const, content: 'hi' },
    { type: 'message' as const, role: 'system' as const, content: 'sys-b' },
  ];
  const input = invocation({ model: 'm', input: input_.map(i => ({ ...i })) }, new Set());

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.input, input_);
});

test('keeps the leading contiguous system run intact when no non-system follows', async () => {
  const input_ = [
    { type: 'message' as const, role: 'system' as const, content: 'sys-a' },
    { type: 'message' as const, role: 'system' as const, content: 'sys-b' },
  ];
  const input = invocation({ model: 'm', input: input_.map(i => ({ ...i })) });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.input, input_);
});

test('preserves the leading system run and demotes every later system message item', async () => {
  const input = invocation({
    model: 'm',
    input: [
      { type: 'message', role: 'system', content: 'sys-a' },
      { type: 'message', role: 'system', content: 'sys-b' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'system', content: 'mid-conversation sys' },
      { type: 'message', role: 'assistant', content: 'sure' },
      { type: 'message', role: 'system', content: 'late sys' },
    ],
  });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.input, [
    { type: 'message', role: 'system', content: 'sys-a' },
    { type: 'message', role: 'system', content: 'sys-b' },
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'message', role: 'user', content: 'mid-conversation sys' },
    { type: 'message', role: 'assistant', content: 'sure' },
    { type: 'message', role: 'user', content: 'late sys' },
  ]);
});

test('treats any non-message item as the boundary that closes the leading system run', async () => {
  const input = invocation({
    model: 'm',
    input: [
      { type: 'message', role: 'system', content: 'sys-a' },
      { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'thinking' }] },
      { type: 'message', role: 'system', content: 'late sys' },
    ],
  });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.input, [
    { type: 'message', role: 'system', content: 'sys-a' },
    { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'thinking' }] },
    { type: 'message', role: 'user', content: 'late sys' },
  ]);
});

test('preserves multi-part content verbatim when demoting', async () => {
  const parts = [
    { type: 'input_text' as const, text: 'one' },
    { type: 'input_text' as const, text: 'two' },
  ];
  const input = invocation({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'system', content: parts },
    ],
  });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.input, [
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'message', role: 'user', content: parts },
  ]);
});

test('is a no-op for an empty input array', async () => {
  const input = invocation({ model: 'm', input: [] });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.input, []);
});

test('is a no-op when input is a plain string', async () => {
  const input = invocation({ model: 'm', input: 'hello' });

  await withInterleavedSystemDemotedToUser(input, stubCtx, okEvents);

  assertEquals(input.payload.input, 'hello');
});
