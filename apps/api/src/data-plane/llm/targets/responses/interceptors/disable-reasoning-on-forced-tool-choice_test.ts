import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
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

const invocation = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice'])): ResponsesInvocation => ({
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

test('responses required tool_choice strips reasoning', async () => {
  const input = invocation({
    model: 'm',
    input: 'hi',
    reasoning: { effort: 'high' },
    tool_choice: 'required',
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

  assertEquals(input.payload.reasoning, undefined);
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

  await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

  assertEquals(input.payload.reasoning, undefined);
});

test('responses vendor flags add explicit disable fields', async () => {
  const input = invocation(
    {
      model: 'm',
      input: 'hi',
      reasoning: { effort: 'high' },
      tool_choice: 'required',
    },
    new Set(['disable-reasoning-on-forced-tool-choice', 'vendor-deepseek', 'vendor-qwen']),
  );

  await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, { type: 'disabled' });
  assertEquals(out.enable_thinking, false);
});

test('responses non-forced tool_choice leaves reasoning untouched', async () => {
  for (const tool_choice of ['auto', 'none'] as const) {
    const input = invocation(
      {
        model: 'm',
        input: 'hi',
        reasoning: { effort: 'high' },
        tool_choice,
      },
      new Set(['vendor-deepseek']),
    );

    await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

    assertEquals(input.payload.reasoning, { effort: 'high' });
    const out = input.payload as unknown as Record<string, unknown>;
    assertEquals(out.thinking, undefined);
  }
});
