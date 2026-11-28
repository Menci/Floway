import { test } from 'vitest';

import type { GeminiGenerateContentPart, GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from '../../src/gemini-generate-content/index.ts';
import { appendGeminiGenerateContentPart, createGeminiGenerateContentEventAccumulator, reassembleGeminiGenerateContentEvents } from '../../src/gemini-generate-content/reassemble.ts';
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

test('reassembleGeminiGenerateContentEvents keeps repeated turnToken scalar across chunks', async () => {
  const result = await reassembleGeminiGenerateContentEvents(eventsFrom([
    {
      turnToken: 'v1_turn_token',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello ' }] } }],
    },
    {
      turnToken: 'v1_turn_token',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'world' }] }, finishReason: 'STOP' }],
    },
  ]));

  assertEquals(result.turnToken, 'v1_turn_token');
  assertEquals(result.candidates?.[0]?.content?.parts, [{ text: 'hello world' }]);
});

test('appendGeminiGenerateContentPart returns target indices and does not merge null text parts', () => {
  const parts: GeminiGenerateContentPart[] = [];
  assertEquals(appendGeminiGenerateContentPart(parts, { text: 'a' }), 0);
  assertEquals(appendGeminiGenerateContentPart(parts, { text: 'b' }), 0);
  assertEquals(appendGeminiGenerateContentPart(parts, { text: null as never }), 1);
  assertEquals(appendGeminiGenerateContentPart(parts, { text: 'c' }), 2);
  assertEquals(appendGeminiGenerateContentPart(parts, { text: 'd', thoughtSignature: 'sig' }), 3);
  assertEquals(parts, [{ text: 'ab' }, { text: null as never }, { text: 'c' }, { text: 'd', thoughtSignature: 'sig' }]);
});

test('reassembleGeminiGenerateContentEvents preserves a terminal finishReason across trailing non-terminal sentinels', async () => {
  const result = await reassembleGeminiGenerateContentEvents(eventsFrom([
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] },
    { candidates: [{ index: 0, finishReason: 'FINISH_REASON_UNSPECIFIED' }] },
    { candidates: [{ index: 0, finishReason: '' as never }] },
    { candidates: [{ index: 0, finishReason: null as never }] },
  ]));
  assertEquals(result.candidates?.[0]?.finishReason, 'STOP');
});

test('reassembleGeminiGenerateContentEvents concatenates per-chunk logprobsResult deltas and sums logProbabilitySum', async () => {
  const result = await reassembleGeminiGenerateContentEvents(eventsFrom([
    {
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'Hel' }] },
        logprobsResult: {
          chosenCandidates: [{ token: 'Hel', logProbability: -0.5 }],
          topCandidates: [{ candidates: [{ token: 'Hel', logProbability: -0.5 }] }],
          logProbabilitySum: -0.5,
        },
      }],
    },
    {
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'lo' }] },
        logprobsResult: {
          chosenCandidates: [{ token: 'lo', logProbability: -1.25 }],
          topCandidates: [{ candidates: [{ token: 'lo', logProbability: -1.25 }] }],
          logProbabilitySum: -1.25,
        },
      }],
    },
    {
      candidates: [{ index: 0, finishReason: 'STOP' }],
    },
  ]));
  assertEquals(result.candidates?.[0]?.logprobsResult, {
    chosenCandidates: [
      { token: 'Hel', logProbability: -0.5 },
      { token: 'lo', logProbability: -1.25 },
    ],
    topCandidates: [
      { candidates: [{ token: 'Hel', logProbability: -0.5 }] },
      { candidates: [{ token: 'lo', logProbability: -1.25 }] },
    ],
    logProbabilitySum: -1.75,
  });
});
