import { test } from 'vitest';

import { backfillRequiredFields } from '../../../src/stages/anthropic-messages/backfill-required-fields.ts';
import type { MessagePayload } from '../../../src/stages/anthropic-messages/types.ts';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

// Casts to Partial<MessagePayload> below model the runtime shape a third-party
// client actually sends: MessagePayload's type says max_tokens is required,
// but the bug exists precisely because clients (cline, aider, etc.) omit it.

test('prefers model.limits.max_output_tokens over the gateway fallback when set', () => {
  const model = stubProviderModel({ endpoints: { anthropicMessages: {} }, limits: { max_output_tokens: 64000 } });
  const payload = backfillRequiredFields(
    {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
    } as Partial<MessagePayload> as MessagePayload,
    model,
  );

  assertEquals(payload.max_tokens, 64000);
});

// Mirrors sub2api gateway_service.go:1301-1306 which writes temperature: 1
// unconditionally when the field is absent. Real CC always emits
// temperature: 1; an absent field breaks the plan-billing fingerprint.
test('backfills temperature to 1 when missing', () => {
  const payload = backfillRequiredFields({
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
  }, stubProviderModel());

  assertEquals(payload.temperature, 1);
});
