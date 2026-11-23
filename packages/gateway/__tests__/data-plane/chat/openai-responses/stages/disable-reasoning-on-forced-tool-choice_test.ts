import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { disableReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/openai-responses/stages/disable-reasoning-on-forced-tool-choice.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const rewrite = async (input: CanonicalOpenAIResponsesPayload) => {
  const { seen, done } = await driveResponsesStage(disableReasoningOnForcedToolChoice, input, { enabledFlags: new Set(['disable-reasoning-on-forced-tool-choice']) });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return { payload: seen };
};

test('responses required tool_choice sets reasoning.effort to none', async () => {
  const input = await rewrite({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'high' },
    tool_choice: 'required',
  });

  assertEquals(input.payload.reasoning, { effort: 'none' });
});

test('responses object tool_choice is forced', async () => {
  const input = await rewrite({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'high' },
    tool_choice: { type: 'custom', name: 'x' },
  });

  assertEquals(input.payload.reasoning, { effort: 'none' });
});

test('responses non-forced tool_choice leaves reasoning untouched', async () => {
  for (const tool_choice of ['auto', 'none'] as const) {
    const input = await rewrite({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      reasoning: { effort: 'high' },
      tool_choice,
    });

    assertEquals(input.payload.reasoning, { effort: 'high' });
  }
});
