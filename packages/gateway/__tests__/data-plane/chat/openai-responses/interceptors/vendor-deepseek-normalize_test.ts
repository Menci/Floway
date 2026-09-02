import { test } from 'vitest';

import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { withVendorDeepSeekOpenAIResponsesNormalize } from '../../../../../src/data-plane/chat/openai-responses/interceptors/vendor-deepseek-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
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

const invocation = (payload: CanonicalOpenAIResponsesPayload, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-deepseek'])): OpenAIResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiResponses',
  headers: new Headers(),
  action: 'generate',
});

test("vendor-deepseek translates canonical reasoning.effort: 'none' into top-level thinking:{type:'disabled'}", async () => {
  const input = invocation({
    model: 'deepseek-reasoner',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'none' },
  });

  await withVendorDeepSeekOpenAIResponsesNormalize(input, stubCtx, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.reasoning, undefined);
  assertEquals(out.thinking, { type: 'disabled' });
});

test('vendor-deepseek leaves a real reasoning.effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const input = invocation({
    model: 'deepseek-reasoner',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'high' },
  });

  await withVendorDeepSeekOpenAIResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'high' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});

test('vendor-deepseek early-returns when its flag is not set on the candidate', async () => {
  const input = invocation({ model: 'deepseek-reasoner', input: [{ type: 'message', role: 'user', content: 'hi' }], reasoning: { effort: 'none' } }, new Set());

  await withVendorDeepSeekOpenAIResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});
