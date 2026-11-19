import { test } from 'vitest';

import type { GeminiGenerateContentStreamEvent, GeminiGenerateContentUsageMetadata } from '../../src/gemini-generate-content/index.ts';
import { billableUsageFromGeminiGenerateContentEvent, billableUsageFromGeminiGenerateContentUsage } from '../../src/gemini-generate-content/usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

const usage = (overrides: Partial<GeminiGenerateContentUsageMetadata>): GeminiGenerateContentUsageMetadata => overrides;

test('bills prompt plus tool-use prompt as input and candidates plus thoughts as output', () => {
  // Gemini's total is the sum of all four buckets, tool-use results are billed
  // as input, and candidates exclude thoughts.
  // https://ai.google.dev/api/generate-content#UsageMetadata
  assertEquals(
    billableUsageFromGeminiGenerateContentUsage(usage({
      promptTokenCount: 500,
      toolUsePromptTokenCount: 300,
      candidatesTokenCount: 120,
      thoughtsTokenCount: 10,
      totalTokenCount: 930,
    })),
    { input: 800, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 130 },
  );
});

test('reads usage off stream chunks and ignores error events', () => {
  const chunk = { candidates: [], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } } satisfies GeminiGenerateContentStreamEvent;
  assertEquals(billableUsageFromGeminiGenerateContentEvent(chunk), { input: 3, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 4 });
  assertEquals(billableUsageFromGeminiGenerateContentEvent({ error: { code: 500, message: 'x', status: 'INTERNAL' } }), null);
  assertEquals(billableUsageFromGeminiGenerateContentEvent({ candidates: [] }), null);
});
