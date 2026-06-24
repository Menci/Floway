import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { ChatCompletionsInvocation } from './types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
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

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (
  payload: ChatCompletionsPayload,
  enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice']),
): ChatCompletionsInvocation => ({
  payload,
  candidate: stubProviderCandidate({ targetApi: 'chat-completions', binding: { enabledFlags } }),
  headers: new Headers(),
});

test('required tool_choice sets reasoning_effort to the canonical none sentinel', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    tool_choice: 'required',
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning_effort, 'none');
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
  assertEquals(out.enable_thinking, undefined);
});

test('object tool_choice is treated as forced', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    tool_choice: { type: 'function', function: { name: 'x' } },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning_effort, 'none');
});

test('non-forced tool_choice leaves reasoning_effort untouched', async () => {
  for (const tool_choice of ['auto', 'none', null] as const) {
    const input = invocation({
      model: 'm',
      messages: [],
      reasoning_effort: 'high',
      tool_choice,
    });

    await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

    assertEquals(input.payload.reasoning_effort, 'high');
  }
});

test('is a no-op when the flag is not set on the binding', async () => {
  const input = invocation(
    { model: 'm', messages: [], reasoning_effort: 'high', tool_choice: 'required' },
    new Set(),
  );

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning_effort, 'high');
});
