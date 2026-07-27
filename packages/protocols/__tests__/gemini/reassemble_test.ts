import { test } from 'vitest';

import type { GeminiResult, GeminiStreamEvent } from '../../src/gemini/index.ts';
import { reassembleGeminiEvents } from '../../src/gemini/reassemble.ts';
import { USAGE_BILLING } from '../../src/common/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const eventsFrom = async function* (events: readonly GeminiStreamEvent[]) {
  yield* events;
};

test('reassembleGeminiEvents assembles candidate parts and final metadata', async () => {
  const events: GeminiStreamEvent[] = [
    {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: 'He' }, { text: 'l' }],
          },
        },
      ],
      modelVersion: 'gemini-test-preview',
      responseId: 'response-early',
    },
    {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: 'lo' }, { text: 'thinking', thought: true }],
          },
        },
        {
          index: 1,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: {} } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 2, totalTokenCount: 4 },
    },
    {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: ' signed', thoughtSignature: 'sig-1' }, { text: ' tail' }],
          },
          finishReason: 'STOP',
        },
      ],
      modelVersion: 'gemini-test',
      responseId: 'response-final',
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 6,
        totalTokenCount: 8,
        thoughtsTokenCount: 1,
      },
    },
  ];

  const expected: GeminiResult = {
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts: [{ text: 'Hello' }, { text: 'thinking', thought: true }, { text: ' signed', thoughtSignature: 'sig-1' }, { text: ' tail' }],
        },
        finishReason: 'STOP',
      },
      {
        index: 1,
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: {} } }],
        },
      },
    ],
    modelVersion: 'gemini-test',
    responseId: 'response-final',
    usageMetadata: {
      promptTokenCount: 2,
      candidatesTokenCount: 6,
      totalTokenCount: 8,
      thoughtsTokenCount: 1,
    },
  };

  assertEquals(await reassembleGeminiEvents(eventsFrom(events)), expected);
});

test('Gemini billing metadata survives reassembly without entering JSON', async () => {
  const usageMetadata = {
    promptTokenCount: 10,
    [USAGE_BILLING]: { cacheWriteTokenCount: 4, serviceTier: 'priority' },
  };
  const result = await reassembleGeminiEvents(eventsFrom([{
    candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
    usageMetadata,
  }]));
  assertEquals(result.usageMetadata?.[USAGE_BILLING], { cacheWriteTokenCount: 4, serviceTier: 'priority' });
  assertEquals(JSON.parse(JSON.stringify(result.usageMetadata)), { promptTokenCount: 10 });
});

test('reassembleGeminiEvents preserves unknown candidate-level and result-level fields', async () => {
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
  } as unknown as GeminiStreamEvent;

  const result = await reassembleGeminiEvents(eventsFrom([event])) as GeminiResult & {
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
