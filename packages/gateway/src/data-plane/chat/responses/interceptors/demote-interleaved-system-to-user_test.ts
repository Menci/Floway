import { test } from 'vitest';

import { withInterleavedSystemDemotedToUser } from './demote-interleaved-system-to-user.ts';
import type { ResponsesInvocation } from './types.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

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
  payload: CanonicalResponsesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['demote-interleaved-system-to-user']),
): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
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
