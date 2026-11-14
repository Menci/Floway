import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import type { GeminiGenerateContentStreamEvent } from '../../src/gemini-generate-content/index.ts';
import { collectGeminiGenerateContentProtocolEventsToResult } from '../../src/gemini-generate-content/to-result.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectGeminiGenerateContentProtocolEventsToResult consumes later candidates and final usage after a candidate finishes', async () => {
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
        candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'Second' }] }, finishReason: 'MAX_TOKENS' }],
      },
      { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
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
    }, { index: 1, content: { role: 'model', parts: [{ text: 'Second' }] }, finishReason: 'MAX_TOKENS' }],
    responseId: 'response-final',
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  });
  assertEquals(consumed, 4);
});

test('collectGeminiGenerateContentProtocolEventsToResult rejects EOF without any candidate completion', async () => {
  await assertRejects(async () => await collectGeminiGenerateContentProtocolEventsToResult((async function* () {
    yield eventFrame({ candidates: [{ content: { parts: [{ text: 'unfinished' }] } }] });
  })()), Error, 'ended without a terminal event');
});

test('collectGeminiGenerateContentProtocolEventsToResult rejects EOF with an unfinished observed candidate', async () => {
  await assertRejects(async () => await collectGeminiGenerateContentProtocolEventsToResult((async function* () {
    yield eventFrame({ candidates: [{ index: 0, content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
    yield eventFrame({ candidates: [{ index: 1, content: { parts: [{ text: 'unfinished' }] } }] });
  })()), Error, 'ended without a terminal event');
});

test('collectGeminiGenerateContentProtocolEventsToResult stops at prompt blocking', async () => {
  const blocked = { promptFeedback: { blockReason: 'SAFETY' } };
  const result = await collectGeminiGenerateContentProtocolEventsToResult((async function* () {
    yield eventFrame(blocked);
    throw new Error('Trailing frame pulled');
  })());
  assertEquals(result, blocked);
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
          throw new Error('Trailing frame pulled');
        })(),
      );
    },
    Error,
    'RESOURCE_EXHAUSTED: quota exceeded',
  );

  assertEquals(error.cause, errorEvent);
});
