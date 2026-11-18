import { test } from 'vitest';

import { restateGeminiGenerateContentError } from '../../../../src/protocols/gemini-generate-content/as-source/error-body.ts';
import { assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown } | undefined) => result!.body as {
  error: { code: number; status: string; message: string };
};

const upstreamOf = (status: number, body: unknown, headers: Record<string, string> = {}) => [
  status,
  new Headers({ 'x-upstream': 'a', ...headers }),
  new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
] as const;

test.each([503])('keeps upstream HTTP %i with its native RPC status', status => {
  const result = restateGeminiGenerateContentError(...upstreamOf(status, { error: { message: 'upstream unavailable' } }));
  assertEquals(result!.status, status);
  assertEquals(decoded(result).error.code, status);
  assertEquals(decoded(result).error.status, 'UNAVAILABLE');
  assertEquals(decoded(result).error.message, 'upstream unavailable');
});

test('keeps a status the inferred table would have flattened', () => {
  const result = restateGeminiGenerateContentError(...upstreamOf(402, { error: { message: 'payment required' } }));

  assertEquals(result!.status, 402);
  assertEquals(decoded(result).error.code, 402);
  assertEquals(decoded(result).error.status, 'UNKNOWN');
});
