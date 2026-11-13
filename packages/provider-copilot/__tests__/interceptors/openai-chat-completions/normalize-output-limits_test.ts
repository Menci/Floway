import { test } from 'vitest';

import { withEquivalentOutputLimitsNormalized } from '../../../src/interceptors/openai-chat-completions/normalize-output-limits.ts';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

test.each([
  { limits: { max_tokens: 32000, max_completion_tokens: 32000 }, expected: { max_completion_tokens: 32000 } },
  { limits: { max_tokens: 0, max_completion_tokens: 0 }, expected: { max_completion_tokens: 0 } },
  { limits: { max_tokens: null, max_completion_tokens: null }, expected: { max_completion_tokens: null } },
  { limits: { max_completion_tokens: 512 }, expected: { max_completion_tokens: 512 } },
  { limits: { max_tokens: 512 }, expected: { max_tokens: 512 } },
  { limits: { max_tokens: 256, max_completion_tokens: 512 }, expected: { max_tokens: 256, max_completion_tokens: 512 } },
  { limits: { max_tokens: null, max_completion_tokens: 512 }, expected: { max_tokens: null, max_completion_tokens: 512 } },
  { limits: {}, expected: {} },
])('Copilot normalizes only equivalent output caps: $limits', async ({ limits, expected }) => {
  const payload = { model: 'test', messages: [], ...limits };
  const before = structuredClone(payload);
  const ctx = { payload, headers: new Headers(), model: stubProviderModel({ endpoints: { openaiChatCompletions: {} } }) };
  const result = eventResult((async function* () {})(), testTelemetryModelIdentity);
  let calls = 0;
  const actual = await withEquivalentOutputLimitsNormalized(ctx, {}, async () => {
    calls++;
    assertEquals(ctx.payload, { model: 'test', messages: [], ...expected });
    return result;
  });
  assertEquals(actual, result);
  assertEquals(calls, 1);
  assertEquals(payload, before);
});
