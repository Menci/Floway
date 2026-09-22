import { test } from 'vitest';

import type { GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from '../../src/gemini-generate-content/index.ts';
import { reassembleGeminiGenerateContentEvents } from '../../src/gemini-generate-content/reassemble.ts';
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
