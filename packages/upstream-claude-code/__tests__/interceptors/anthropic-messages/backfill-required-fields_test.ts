import { test } from 'vitest';

import { backfillRequiredFields } from '../../../src/interceptors/anthropic-messages/backfill-required-fields.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';
import type { UpstreamModel, UpstreamStreamResult } from '@floway-dev/upstream';

const okEvents = (): Promise<UpstreamStreamResult<AnthropicMessagesStreamEventEx>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: AnthropicMessagesPayload, model: UpstreamModel = stubUpstreamModel({ endpoints: { anthropicMessages: {} } })): AnthropicMessagesBoundaryCtx => ({
  payload,
  model,
  upstreamId: 'up_test',
});

// Casts to Partial<AnthropicMessagesPayload> below model the runtime shape a third-party
// client actually sends: AnthropicMessagesPayload's type says max_tokens is required,
// but the bug exists precisely because clients (cline, aider, etc.) omit it.

test('prefers model.limits.max_output_tokens over the gateway fallback when set', async () => {
  const model = stubUpstreamModel({ endpoints: { anthropicMessages: {} }, limits: { max_output_tokens: 64000 } });
  const ctx = invocation(
    {
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
    } as Partial<AnthropicMessagesPayload> as AnthropicMessagesPayload,
    model,
  );

  await backfillRequiredFields(ctx, {}, okEvents);

  assertEquals(ctx.payload.max_tokens, 64000);
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
