import { test } from 'vitest';

import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { CanonicalResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, assertFalse, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: CanonicalResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

test('drops every field Codex rejects with Unsupported parameter', async () => {
  // The fields enumerated below are the full set Codex's ChatGPT-subscription
  // path rejects; keeping the assertion exhaustive guards against silent
  // drift if the constant inside the interceptor is edited without updating
  // its rationale. Several entries (frequency_penalty, presence_penalty,
  // user, stream_options) are not on the canonical payload and reach Codex only
  // through a permissive caller. `prompt_cache_retention` is modeled but
  // explicitly rejected by this provider. Widen through `unknown` so the test
  // covers the complete strip set.
  const ctx = invocation({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    max_output_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    user: 'caller-id',
    metadata: { trace_id: 'abc' },
    prompt_cache_retention: '24h',
    safety_identifier: 'caller-supplied',
    stream_options: { include_usage: true },
  } as unknown as CanonicalResponsesPayload);

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertFalse('max_output_tokens' in ctx.payload);
  assertFalse('temperature' in ctx.payload);
  assertFalse('top_p' in ctx.payload);
  assertFalse('frequency_penalty' in ctx.payload);
  assertFalse('presence_penalty' in ctx.payload);
  assertFalse('user' in ctx.payload);
  assertFalse('metadata' in ctx.payload);
  assertFalse('prompt_cache_retention' in ctx.payload);
  assertFalse('safety_identifier' in ctx.payload);
  assertFalse('stream_options' in ctx.payload);
});

test('leaves supported fields intact', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    instructions: 'be terse',
    prompt_cache_options: { mode: 'future_mode', ttl: '1h' },
    stream: true,
    store: false,
    temperature: 0.7,
  });

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.model, 'gpt-test');
  assertEquals(ctx.payload.input, [{ type: 'message', role: 'user', content: 'hello' }]);
  assertEquals(ctx.payload.instructions, 'be terse');
  assertEquals(ctx.payload.prompt_cache_options, { mode: 'future_mode', ttl: '1h' });
  assertEquals(ctx.payload.stream, true);
  assertEquals(ctx.payload.store, false);
  assertFalse('temperature' in ctx.payload);
});

test('payload without any unsupported fields is preserved as-is', async () => {
  const payload: CanonicalResponsesPayload = { model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] };
  const ctx = invocation(payload);

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload, { model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] });
});
