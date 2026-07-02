import { test } from 'vitest';

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: ResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

test('injects the default when instructions is absent', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello' });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
});

test('injects the default when instructions is an empty string', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello', instructions: '' });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
});

test('preserves a caller-supplied instructions string', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello', instructions: 'You are a pirate.' });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'You are a pirate.');
});

test('injects the default and preserves in-array role:"system" items when no top-level instructions are supplied', async () => {
  // Behavior validated after removing hoist-system-input-to-instructions:
  // in-array system items are not promoted into the `instructions` field,
  // so this interceptor still injects the Codex default. Both layers reach
  // the upstream — the Codex agent template via `instructions`, the caller's
  // pinned context via the input array — which is the intended split now
  // that the Codex backend accepts mid-array role:'system'.
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'system', content: 'be terse' },
      { type: 'message', role: 'user', content: 'who are you' },
    ],
  });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
  assertEquals(ctx.payload.input, [
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'message', role: 'system', content: 'be terse' },
    { type: 'message', role: 'user', content: 'who are you' },
  ]);
});
