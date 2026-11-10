import { test } from 'vitest';

import type { GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from '../../src/gemini-generate-content/index.ts';
import { createGeminiGenerateContentEventAccumulator, reassembleGeminiGenerateContentEvents } from '../../src/gemini-generate-content/reassemble.ts';
import { assertEquals } from '@floway-dev/test-utils';

const eventsFrom = async function* (events: readonly GeminiGenerateContentStreamEvent[]) {
  yield* events;
};

test('reassembleGeminiGenerateContentEvents preserves unknown candidate-level and result-level fields', async () => {
  const event = {
    modelVersion: 'gemini-test',
    responseId: 'resp_1',
    candidates: [{
      index: 0,
      content: { role: 'model', parts: [{ text: 'hi' }] },
      finishReason: 'STOP',
      safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' }],
      citationMetadata: { citations: [] },
      tokenCount: 7,
    }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
    promptFeedback: { safetyRatings: [] },
    this_is_a_non_standard_field_of_reasoning: 'unknown_top_value',
  } as unknown as GeminiGenerateContentStreamEvent;

  const result = await reassembleGeminiGenerateContentEvents(eventsFrom([event])) as GeminiGenerateContentResult & {
    promptFeedback?: unknown;
    this_is_a_non_standard_field_of_reasoning?: string;
  };
  const candidate = result.candidates?.[0] as { safetyRatings?: unknown; citationMetadata?: unknown; tokenCount?: number };
  assertEquals(candidate.safetyRatings, [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' }]);
  assertEquals(candidate.citationMetadata, { citations: [] });
  assertEquals(candidate.tokenCount, 7);
  assertEquals(result.promptFeedback, { safetyRatings: [] });
  assertEquals(result.this_is_a_non_standard_field_of_reasoning, 'unknown_top_value');
});

test('preserves metadata-bearing text parts and finish-only candidates', async () => {
  const result = await reassembleGeminiGenerateContentEvents(eventsFrom([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'first', partMetadata: { source: 1 } }] } }] },
    { candidates: [{ content: { parts: [{ text: 'second', speechMetadata: { speaker: 'other' } }] } }] },
    { candidates: [{ finishReason: 'STOP' }] },
  ]));
  assertEquals(result.candidates, [{
    index: 0,
    content: {
      role: 'model', parts: [
        { text: 'first', partMetadata: { source: 1 } },
        { text: 'second', speechMetadata: { speaker: 'other' } },
      ],
    },
    finishReason: 'STOP',
  }]);
});

test('result reflects all events accepted before each read', () => {
  const accumulator = createGeminiGenerateContentEventAccumulator();
  accumulator.accept({
    candidates: [
      { index: 0, content: { role: 'model', parts: [{ text: 'zero' }] } },
      { index: 1, content: { role: 'model', parts: [{ text: 'one' }] } },
    ],
  });

  assertEquals(accumulator.result().candidates?.map(candidate => candidate.content), [
    { role: 'model', parts: [{ text: 'zero' }] },
    { role: 'model', parts: [{ text: 'one' }] },
  ]);
  accumulator.accept({ candidates: [{ index: 1, content: { parts: [{ text: ' continued' }] }, finishReason: 'STOP' }] });

  assertEquals(accumulator.result().candidates?.map(candidate => candidate.content), [
    { role: 'model', parts: [{ text: 'zero' }] },
    { role: 'model', parts: [{ text: 'one continued' }] },
  ]);
});

test('candidate reads use wire indices and the same projection as the complete result', () => {
  const accumulator = createGeminiGenerateContentEventAccumulator();
  assertEquals(accumulator.candidate(8), undefined);
  const event = {
    candidates: [
      { index: 8, content: { role: 'model', parts: [{ text: 'eight' }] }, vendorText: 'first' },
      { index: 2, finishReason: 'SAFETY' },
    ],
  };
  accumulator.accept(event);
  assertEquals(accumulator.candidate(0), undefined);
  assertEquals(accumulator.candidate(2), { index: 2, finishReason: 'SAFETY' });
  assertEquals(accumulator.candidate(8), {
    index: 8, content: { role: 'model', parts: [{ text: 'eight' }] }, vendorText: 'first',
  });
  const update = { candidates: [{ index: 8, content: { parts: [{ text: ' continued' }] }, vendorText: ' second' }] };
  accumulator.accept(update);
  assertEquals(accumulator.candidate(8), {
    index: 8, content: { role: 'model', parts: [{ text: 'eight continued' }] }, vendorText: 'first second',
  });
  assertEquals(accumulator.result().candidates, [accumulator.candidate(2), accumulator.candidate(8)]);
});
