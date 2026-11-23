import { test } from 'vitest';

import { driveResponsesStage } from './drive.ts';
import { forceStoreFalse } from '../../../../../src/data-plane/chat/openai-responses/stages/force-store-false.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const rewrite = async (input: CanonicalOpenAIResponsesPayload) => {
  const { seen, done } = await driveResponsesStage(forceStoreFalse, input, { enabledFlags: new Set(['openai-responses-store-false']) });
  assert(seen !== undefined);
  assertEquals(await done, { ok: true });
  return { payload: seen };
};

test('when openai-responses-store-false is on, change "store":true to false', async () => {
  const ctx = await rewrite({
    model: 'gpt-5.2',
    store: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
  });

  assertEquals(ctx.payload.store, false);
});
