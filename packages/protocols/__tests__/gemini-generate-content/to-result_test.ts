import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import type { GeminiGenerateContentStreamEvent } from '../../src/gemini-generate-content/index.ts';
import { collectGeminiGenerateContentProtocolEventsToResult } from '../../src/gemini-generate-content/to-result.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectGeminiGenerateContentProtocolEventsToResult consumes preterminal events and stops at the terminal event', async () => {
  let consumed = 0;
  const frames = (async function* () {
    const events = [
      {
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: 'Hel' }] },
        }],
      },
      {
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: 'lo' }] },
          finishReason: 'STOP',
        }],
        responseId: 'response-final',
      },
      {
        error: {
          code: 500,
          message: 'must not be consumed',
          status: 'INTERNAL',
        },
      },
    ] satisfies GeminiGenerateContentStreamEvent[];

    for (const event of events) {
      consumed += 1;
      yield eventFrame(event);
    }
  })();

  assertEquals(await collectGeminiGenerateContentProtocolEventsToResult(frames), {
    candidates: [{
      index: 0,
      content: { role: 'model', parts: [{ text: 'Hello' }] },
      finishReason: 'STOP',
    }],
    responseId: 'response-final',
  });
  assertEquals(consumed, 2);
});

test('collectGeminiGenerateContentProtocolEventsToResult throws Gemini generateContent error events', async () => {
  const errorEvent = {
    error: {
      code: 429,
      message: 'quota exceeded',
      status: 'RESOURCE_EXHAUSTED',
    },
  } satisfies GeminiGenerateContentStreamEvent;

  const error = await assertRejects(
    async () => {
      await collectGeminiGenerateContentProtocolEventsToResult(
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
