import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { ResponsesInvocation } from './types.ts';
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

const invocation = (
  payload: ResponsesPayload,
  enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice']),
): ResponsesInvocation => ({
  payload,
  candidate: stubProviderCandidate({ model: { enabledFlags } }),
  targetApi: 'responses',
  store: new LayeredStatefulResponsesStore({
    apiKeyId: 'test-key',
    reads: [new MemoryStatefulResponsesBacking()],
    itemWrites: [],
    snapshotWrites: [],
    stageInputs: false,
  }),
  headers: new Headers(),
  action: 'generate',
});

test('responses required tool_choice sets reasoning.effort to none', async () => {
  const input = invocation({
    model: 'm',
    input: 'hi',
    reasoning: { effort: 'high' },
    tool_choice: 'required',
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
  assertEquals(out.enable_thinking, undefined);
});

test('responses object tool_choice is forced', async () => {
  const input = invocation({
    model: 'm',
    input: 'hi',
    reasoning: { effort: 'high' },
    tool_choice: { type: 'custom', name: 'x' },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
});

test('responses non-forced tool_choice leaves reasoning untouched', async () => {
  for (const tool_choice of ['auto', 'none'] as const) {
    const input = invocation({
      model: 'm',
      input: 'hi',
      reasoning: { effort: 'high' },
      tool_choice,
    });

    await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

    assertEquals(input.payload.reasoning, { effort: 'high' });
  }
});
