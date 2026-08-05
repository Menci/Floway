import { test } from 'vitest';

import { tokenUsageFromEmbeddingsBody } from '../../../src/data-plane/embeddings/usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test.each([
  ['zero', 0, {}],
  ['maximum safe integer', Number.MAX_SAFE_INTEGER, { input: Number.MAX_SAFE_INTEGER }],
] as const)('embeddings usage accepts %s token counts', (_name, count, expected) => {
  assertEquals(tokenUsageFromEmbeddingsBody({
    usage: { prompt_tokens: count, total_tokens: count },
  }), expected);
});

test.each([
  ['array body', []],
  ['array usage', { usage: [] }],
  ['missing prompt_tokens', { usage: { total_tokens: 1 } }],
  ['missing total_tokens', { usage: { prompt_tokens: 1 } }],
  ['negative prompt_tokens', { usage: { prompt_tokens: -1, total_tokens: -1 } }],
  ['negative total_tokens', { usage: { prompt_tokens: 1, total_tokens: -1 } }],
  ['fractional prompt_tokens', { usage: { prompt_tokens: 0.5, total_tokens: 0.5 } }],
  ['fractional total_tokens', { usage: { prompt_tokens: 1, total_tokens: 1.5 } }],
  ['non-finite prompt_tokens', { usage: { prompt_tokens: Number.NaN, total_tokens: Number.NaN } }],
  ['non-finite total_tokens', { usage: { prompt_tokens: 1, total_tokens: Number.POSITIVE_INFINITY } }],
  ['unsafe prompt_tokens', { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 } }],
  ['unsafe total_tokens', { usage: { prompt_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 } }],
  ['mismatched total_tokens', { usage: { prompt_tokens: 1, total_tokens: 2 } }],
] as const)('embeddings usage rejects %s', (_name, body) => {
  assertEquals(tokenUsageFromEmbeddingsBody(body), null);
});
