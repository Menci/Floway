import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { vendorDeepSeekNormalize } from '../../../../../src/data-plane/chat/openai-responses/stages/vendor-deepseek-normalize.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const rewrite = async (input: CanonicalOpenAIResponsesPayload) => {
  const { seen, done } = await driveResponsesStage(vendorDeepSeekNormalize, input, { enabledFlags: new Set(['vendor-deepseek']) });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return { payload: seen };
};

test("vendor-deepseek translates canonical reasoning.effort: 'none' into top-level thinking:{type:'disabled'}", async () => {
  const input = await rewrite({
    model: 'deepseek-reasoner',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'none' },
  });

  const out = input.payload as CanonicalOpenAIResponsesPayload & Record<string, unknown>;
  assertEquals(out.reasoning, undefined);
  assertEquals(out.thinking, { type: 'disabled' });
});
