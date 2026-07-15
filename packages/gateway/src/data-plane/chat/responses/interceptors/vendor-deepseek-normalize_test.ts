import { test } from 'vitest';

import type { ResponsesInvocation } from './types.ts';
import { withVendorDeepseekResponsesNormalize } from './vendor-deepseek-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
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

const invocation = (payload: CanonicalResponsesPayload, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-deepseek'])): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

test("vendor-deepseek translates canonical reasoning.effort: 'none' into top-level thinking:{type:'disabled'}", async () => {
  const input = invocation({
    model: 'deepseek-reasoner',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'none' },
  });

  await withVendorDeepseekResponsesNormalize(input, stubCtx, okEvents);

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

  await withVendorDeepseekResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'high' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});

test('vendor-deepseek early-returns when its flag is not set on the candidate', async () => {
  const input = invocation({ model: 'deepseek-reasoner', input: [{ type: 'message', role: 'user', content: 'hi' }], reasoning: { effort: 'none' } }, new Set());

  await withVendorDeepseekResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});
