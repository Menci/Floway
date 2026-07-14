import { expect, test } from 'vitest';

import { tokenUsageFromResponsesResult } from './usage.ts';
import { USAGE_BILLING } from '@floway-dev/protocols/common';
import type { ResponsesResult } from '@floway-dev/protocols/responses';
import { assertEquals } from '@floway-dev/test-utils';

// Bare minimum ResponsesResult to exercise the usage extractor. The mapper
// only touches `usage` and `service_tier`; the rest of the response shape is
// irrelevant to billing.
const minimalResult = (overrides: Partial<ResponsesResult>): ResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: 'gpt-test',
  output: [],
  status: 'completed',
  incomplete_details: null,
  error: null,
  ...overrides,
});

test('Responses usage maps disjoint input/cache/output counts and omits tier when service_tier is absent', () => {
  const result = minimalResult({
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 30 } },
  });
  assertEquals(tokenUsageFromResponsesResult(result), {
    input: 70,
    input_cache_read: 30,
    output: 20,
  });
});

test('Responses usage splits cache-read and cache-write out of the inclusive input total', () => {
  const result = minimalResult({
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 } },
  });
  assertEquals(tokenUsageFromResponsesResult(result), {
    input: 45,
    input_cache_read: 30,
    input_cache_write: 25,
    output: 20,
  });
});

test('Responses usage preserves translated 1-hour cache writes', () => {
  const result = minimalResult({
    usage: {
      input_tokens: 20,
      output_tokens: 2,
      total_tokens: 22,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 9 },
      [USAGE_BILLING]: { cacheWrite1hTokenCount: 5 },
    },
  });
  assertEquals(tokenUsageFromResponsesResult(result), {
    input: 11,
    input_cache_write: 4,
    input_cache_write_1h: 5,
    output: 2,
  });
});

test('Responses usage rejects a malformed payload whose cache splits exceed the input total rather than clamping', () => {
  const result = minimalResult({
    usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 } },
  });
  expect(() => tokenUsageFromResponsesResult(result)).toThrowError(RangeError);
});

test('Responses usage drops service_tier=default (OpenAI base value) to no-tier', () => {
  const result = minimalResult({
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    service_tier: 'default',
  });
  assertEquals(tokenUsageFromResponsesResult(result), {
    input: 10,
    output: 2,
  });
});

test('Responses usage forwards service_tier=priority verbatim', () => {
  const result = minimalResult({
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    service_tier: 'priority',
  });
  assertEquals(tokenUsageFromResponsesResult(result), {
    input: 10,
    output: 2,
    tier: 'priority',
  });
});

test('Responses usage forwards service_tier=flex verbatim', () => {
  const result = minimalResult({
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    service_tier: 'flex',
  });
  assertEquals(tokenUsageFromResponsesResult(result), {
    input: 10,
    output: 2,
    tier: 'flex',
  });
});

test('Responses usage forwards an unknown tier verbatim (forward-compat with a future wire value)', () => {
  const result = minimalResult({
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    service_tier: 'batch',
  });
  assertEquals(tokenUsageFromResponsesResult(result), {
    input: 10,
    output: 2,
    tier: 'batch',
  });
});

test('Responses usage returns null when the upstream omits the usage object', () => {
  assertEquals(tokenUsageFromResponsesResult(minimalResult({})), null);
});
