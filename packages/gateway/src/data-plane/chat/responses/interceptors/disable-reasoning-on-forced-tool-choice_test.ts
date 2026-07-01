import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
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
  payload: CanonicalResponsesPayload,
  enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice']),
): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

test('responses required tool_choice sets reasoning.effort to none', async () => {
  const input = invocation({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
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
    input: [{ type: 'message', role: 'user', content: 'hi' }],
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
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      reasoning: { effort: 'high' },
      tool_choice,
    });

    await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

    assertEquals(input.payload.reasoning, { effort: 'high' });
  }
});
