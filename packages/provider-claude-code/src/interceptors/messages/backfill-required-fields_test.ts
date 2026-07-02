import { test } from 'vitest';

import { backfillRequiredFields } from './backfill-required-fields.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { MESSAGES_FALLBACK_MAX_TOKENS, type MessagesPayload, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ProviderModel, ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const okEvents = (): Promise<ProviderStreamResult<MessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: MessagesPayload, model: ProviderModel = stubProviderModel({ endpoints: { messages: {} } })): ClaudeCodeMessagesBoundaryCtx => ({
  payload,
  model,
  upstreamId: 'up_test',
});

// Casts to Partial<MessagesPayload> below model the runtime shape a third-party
// client actually sends: MessagesPayload's type says max_tokens is required,
// but the bug exists precisely because clients (cline, aider, etc.) omit it.

test('backfills max_tokens from MESSAGES_FALLBACK_MAX_TOKENS when both payload and model limits are silent', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
  } as Partial<MessagesPayload> as MessagesPayload);

  await backfillRequiredFields(ctx, {}, okEvents);

  assertEquals(ctx.payload.max_tokens, MESSAGES_FALLBACK_MAX_TOKENS);
});

test('prefers model.limits.max_output_tokens over the gateway fallback when set', async () => {
  const model = stubProviderModel({ endpoints: { messages: {} }, limits: { max_output_tokens: 64000 } });
  const ctx = invocation(
    {
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
    } as Partial<MessagesPayload> as MessagesPayload,
    model,
  );

  await backfillRequiredFields(ctx, {}, okEvents);

  assertEquals(ctx.payload.max_tokens, 64000);
});

test('preserves caller-supplied max_tokens', async () => {
  const model = stubProviderModel({ endpoints: { messages: {} }, limits: { max_output_tokens: 64000 } });
  const ctx = invocation(
    {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
    },
    model,
  );

  await backfillRequiredFields(ctx, {}, okEvents);

  assertEquals(ctx.payload.max_tokens, 100);
});

// Mirrors sub2api gateway_service.go:1301-1306 which writes temperature: 1
// unconditionally when the field is absent. Real CC always emits
// temperature: 1; an absent field breaks the plan-billing fingerprint.
test('backfills temperature to 1 when missing', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await backfillRequiredFields(ctx, {}, okEvents);

  assertEquals(ctx.payload.temperature, 1);
});

test('preserves caller-supplied temperature', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
  });

  await backfillRequiredFields(ctx, {}, okEvents);

  assertEquals(ctx.payload.temperature, 0.7);
});

// Explicit zero must survive (legitimate deterministic-decoding choice;
// the `??=` operator only fills `null`/`undefined`, so `0` survives).
test('preserves caller-supplied temperature: 0', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
  });

  await backfillRequiredFields(ctx, {}, okEvents);

  assertEquals(ctx.payload.temperature, 0);
});
