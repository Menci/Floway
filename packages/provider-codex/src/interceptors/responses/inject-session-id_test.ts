import { test } from 'vitest';

import { injectSessionId } from './inject-session-id.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: ResponsesPayload, headers: Headers = new Headers()): ResponsesBoundaryCtx => ({
  payload,
  headers,
  model: stubUpstreamModel({ endpoints: { responses: {} } }),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('injects a UUID-shaped session-id header when none is set', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi', instructions: 'You are helpful.' });

  await injectSessionId(ctx, stubRequest, okEvents);

  const sessionId = ctx.headers.get('session-id');
  assert(sessionId !== null && UUID_RE.test(sessionId), `expected UUID, got ${sessionId}`);
});

test('produces a stable id across calls with the same prefix', async () => {
  const a = invocation({ model: 'gpt-test', input: 'first turn', instructions: 'Sys prompt.' });
  const b = invocation({
    model: 'gpt-test',
    instructions: 'Sys prompt.',
    input: [
      { type: 'message', role: 'user', content: 'first turn' },
      { type: 'message', role: 'assistant', content: 'something earlier' },
      { type: 'message', role: 'user', content: 'second turn' },
    ],
  });

  await injectSessionId(a, stubRequest, okEvents);
  await injectSessionId(b, stubRequest, okEvents);

  assertEquals(a.headers.get('session-id'), b.headers.get('session-id'));
});

test('produces different ids for different system prompts', async () => {
  const a = invocation({ model: 'gpt-test', input: 'hello', instructions: 'You are pirate.' });
  const b = invocation({ model: 'gpt-test', input: 'hello', instructions: 'You are scientist.' });

  await injectSessionId(a, stubRequest, okEvents);
  await injectSessionId(b, stubRequest, okEvents);

  assert(a.headers.get('session-id') !== b.headers.get('session-id'), 'expected distinct session-ids');
});

test('produces different ids for different first user messages', async () => {
  const a = invocation({ model: 'gpt-test', input: 'topic A', instructions: 'Sys.' });
  const b = invocation({ model: 'gpt-test', input: 'topic B', instructions: 'Sys.' });

  await injectSessionId(a, stubRequest, okEvents);
  await injectSessionId(b, stubRequest, okEvents);

  assert(a.headers.get('session-id') !== b.headers.get('session-id'), 'expected distinct session-ids');
});

test('honors a client-supplied session-id (hyphen form) without overwriting', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi' }, new Headers({ 'session-id': 'client-supplied' }));

  await injectSessionId(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), 'client-supplied');
});

test('canonicalizes a client-supplied session_id alias when session-id is absent', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi' }, new Headers({ session_id: 'client-supplied' }));

  await injectSessionId(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), 'client-supplied');
  assertEquals(ctx.headers.get('session_id'), null);
});

test('prefers session-id over a client-supplied session_id alias', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi' }, new Headers({
    'session-id': 'canonical',
    session_id: 'alias',
  }));

  await injectSessionId(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), 'canonical');
  assertEquals(ctx.headers.get('session_id'), null);
});

test('handles array input by reading the first role:"user" item', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'system', content: 'sys' },
      { type: 'message', role: 'user', content: 'real first user message' },
    ],
  });

  await injectSessionId(ctx, stubRequest, okEvents);

  // sanity: the produced id matches what we'd compute from the first user
  // message + empty instructions
  const compare = invocation({ model: 'gpt-test', input: 'real first user message' });
  await injectSessionId(compare, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), compare.headers.get('session-id'));
});
