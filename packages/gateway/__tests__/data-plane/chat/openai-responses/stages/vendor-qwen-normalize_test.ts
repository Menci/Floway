import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { vendorQwenNormalize } from '../../../../../src/data-plane/chat/openai-responses/stages/vendor-qwen-normalize.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const rewrite = async (input: CanonicalOpenAIResponsesPayload) => {
  const { seen, done } = await driveResponsesStage(vendorQwenNormalize, input, { enabledFlags: new Set(['vendor-qwen']) });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return { payload: seen };
};

test("vendor-qwen translates canonical reasoning.effort: 'none' into top-level enable_thinking:false", async () => {
  const input = await rewrite({
    model: 'qwen-max',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'none' },
  });

  const out = input.payload as CanonicalOpenAIResponsesPayload & Record<string, unknown>;
  assertEquals(out.reasoning, undefined);
  assertEquals(out.enable_thinking, false);
});
