import { test } from 'vitest';

import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, assertFalse, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: ResponsesPayload): ResponsesBoundaryCtx => ({
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
  // user, prompt_cache_retention, stream_options) are not on the canonical
  // `ResponsesPayload` shape — they reach Codex only when an upstream
  // translator or a permissive caller smuggles them in, which is exactly
  // the case the interceptor exists to handle, so we widen the literal
  // through `unknown` for the test.
  const ctx = invocation({
    model: 'gpt-test',
    input: 'hello',
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
  } as unknown as ResponsesPayload);

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
    input: 'hello',
    instructions: 'be terse',
    stream: true,
    store: false,
    temperature: 0.7,
  });

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.model, 'gpt-test');
  assertEquals(ctx.payload.input, 'hello');
  assertEquals(ctx.payload.instructions, 'be terse');
  assertEquals(ctx.payload.stream, true);
  assertEquals(ctx.payload.store, false);
  assertFalse('temperature' in ctx.payload);
});

test('payload without any unsupported fields is preserved as-is', async () => {
  const payload: ResponsesPayload = { model: 'gpt-test', input: 'hello' };
  const ctx = invocation(payload);

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload, { model: 'gpt-test', input: 'hello' });
});
