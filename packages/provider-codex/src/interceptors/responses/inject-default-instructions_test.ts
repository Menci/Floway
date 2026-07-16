import { test } from 'vitest';

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { CanonicalResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: CanonicalResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

test('injects the default when instructions is absent', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
});

test('injects the default when instructions is an empty string', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], instructions: '' });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
});

test('injects the default when instructions is null', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], instructions: null });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
});

test('preserves a caller-supplied instructions string', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], instructions: 'You are a pirate.' });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'You are a pirate.');
});

test.each([
  { name: 'number', value: 42 },
  { name: 'boolean', value: false },
  { name: 'object', value: { text: 'invalid' } },
  { name: 'array', value: ['invalid'] },
])(
  'preserves malformed $name instructions for upstream validation',
  async ({ value }) => {
    const ctx = invocation({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      instructions: value as unknown as string,
    });

    await injectDefaultInstructions(ctx, stubRequest, okEvents);

    assertEquals(ctx.payload.instructions, value);
  },
);

test('injects the default and preserves input items it does not own', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'developer', content: 'be terse' },
      { type: 'message', role: 'user', content: 'who are you' },
    ],
  });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
  assertEquals(ctx.payload.input, [
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'message', role: 'developer', content: 'be terse' },
    { type: 'message', role: 'user', content: 'who are you' },
  ]);
});
