import { test } from 'vitest';

import type { ResponsesInvocation } from './types.ts';
import { withVendorDeepseekResponsesNormalize } from './vendor-deepseek-normalize.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: GatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
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

const invocation = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['vendor-deepseek'])): ResponsesInvocation => ({
  payload,
  candidate: stubProviderCandidate({ targetApi: 'responses', binding: { enabledFlags } }),
  store: new LayeredStatefulResponsesStore({
    apiKeyId: 'test-key',
    reads: [new MemoryStatefulResponsesBacking()],
    itemWrites: [],
    snapshotWrites: [],
    stageInputs: false,
  }),
  headers: new Headers(),
});

test("vendor-deepseek translates canonical reasoning.effort: 'none' into top-level thinking:{type:'disabled'}", async () => {
  const input = invocation({
    model: 'deepseek-reasoner',
    input: 'hi',
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
    input: 'hi',
    reasoning: { effort: 'high' },
  });

  await withVendorDeepseekResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'high' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});

test('vendor-deepseek early-returns when its flag is not set on the binding', async () => {
  const input = invocation({ model: 'deepseek-reasoner', input: 'hi', reasoning: { effort: 'none' } }, new Set());

  await withVendorDeepseekResponsesNormalize(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});
