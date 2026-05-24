import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { chatCompletionsInvocation, stubRequestContext, testTelemetryModelIdentity } from './test-helpers.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { eventResult } from '../../../shared/errors/result.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const emitInput = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice'])): ReturnType<typeof chatCompletionsInvocation> =>
  chatCompletionsInvocation(payload, enabledFlags);

test('chat completions required tool_choice strips reasoning_effort', async () => {
  const input = emitInput({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    tool_choice: 'required',
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequestContext, okEvents);

  assertEquals(input.payload.reasoning_effort, undefined);
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
  assertEquals(out.enable_thinking, undefined);
});

test('chat completions object tool_choice is forced', async () => {
  const input = emitInput({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    tool_choice: { type: 'function', function: { name: 'x' } },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequestContext, okEvents);

  assertEquals(input.payload.reasoning_effort, undefined);
});

test('chat completions vendor flags add explicit disable fields', async () => {
  const input = emitInput(
    {
      model: 'm',
      messages: [],
      reasoning_effort: 'high',
      tool_choice: 'required',
    },
    new Set(['disable-reasoning-on-forced-tool-choice', 'vendor-deepseek', 'vendor-qwen']),
  );

  await withReasoningDisabledOnForcedToolChoice(input, stubRequestContext, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, { type: 'disabled' });
  assertEquals(out.enable_thinking, false);
});

test('chat completions non-forced tool_choice leaves reasoning untouched', async () => {
  for (const tool_choice of ['auto', 'none', null] as const) {
    const input = emitInput(
      {
        model: 'm',
        messages: [],
        reasoning_effort: 'high',
        tool_choice,
      },
      new Set(['vendor-deepseek']),
    );

    await withReasoningDisabledOnForcedToolChoice(input, stubRequestContext, okEvents);

    assertEquals(input.payload.reasoning_effort, 'high');
    const out = input.payload as unknown as Record<string, unknown>;
    assertEquals(out.thinking, undefined);
  }
});
