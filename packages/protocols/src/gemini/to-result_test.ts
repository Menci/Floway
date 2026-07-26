import { test } from 'vitest';

import type { GeminiStreamEvent } from './index.ts';
import { collectGeminiProtocolEventsToResult } from './to-result.ts';
import { eventFrame } from '../common/index.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectGeminiProtocolEventsToResult throws Gemini error events', async () => {
  const errorEvent = {
    error: {
      code: 429,
      message: 'quota exceeded',
      status: 'RESOURCE_EXHAUSTED',
    },
  } satisfies GeminiStreamEvent;

  const error = await assertRejects(
    async () => {
      await collectGeminiProtocolEventsToResult(
        (async function* () {
          yield eventFrame(errorEvent);
        })(),
      );
    },
    Error,
    'RESOURCE_EXHAUSTED: quota exceeded',
  );

  assertEquals(error.cause, errorEvent);
});
