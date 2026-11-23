import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { stripPromptCacheKey } from '../../../../../src/data-plane/chat/openai-responses/stages/strip-prompt-cache-key.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const rewrite = async (input: CanonicalOpenAIResponsesPayload) => {
  const { seen, done } = await driveResponsesStage(stripPromptCacheKey, input, { enabledFlags: new Set(['strip-prompt-cache-key']) });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return { payload: seen };
};

test('drops top-level prompt_cache_key when the flag is on', async () => {
  const input = await rewrite({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    prompt_cache_key: 'thread-42',
  });

  assertEquals(Object.hasOwn(input.payload, 'prompt_cache_key'), false);
});
