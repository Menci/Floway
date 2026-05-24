import { test } from 'vitest';

import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../interceptors.ts';
import { eventResult } from '../../../shared/errors/result.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['vendor-qwen'])): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags,
  headers: {},
});

test("vendor-qwen translates canonical reasoning.effort: 'none' into top-level enable_thinking:false", async () => {
  const input = invocation({
    model: 'qwen-max',
    input: 'hi',
    reasoning: { effort: 'none' },
  });

  await withVendorQwenResponsesNormalize(input, stubRequest, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.reasoning, undefined);
  assertEquals(out.enable_thinking, false);
});

test('vendor-qwen leaves a real reasoning.effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const input = invocation({ model: 'qwen-max', input: 'hi', reasoning: { effort: 'high' } });

  await withVendorQwenResponsesNormalize(input, stubRequest, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'high' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});

test('vendor-qwen early-returns when its flag is not set on the binding', async () => {
  const input = invocation({ model: 'qwen-max', input: 'hi', reasoning: { effort: 'none' } }, new Set());

  await withVendorQwenResponsesNormalize(input, stubRequest, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});
