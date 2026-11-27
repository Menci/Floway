import { test } from 'vitest';

import { writeGeminiGenerateContentError } from '../../../../src/protocols/gemini-generate-content/as-source/error.ts';
import { irErrorPayloadFromBody } from '../../../../src/shared/api-error.ts';
import { assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown }) => result.body as {
  error: { code: number; status: string; message: string };
};

const writeFrom = (status: number, body: unknown) => {
  const payload = irErrorPayloadFromBody(new TextEncoder().encode(JSON.stringify(body)));
  if (payload === undefined) throw new Error('Expected parsed IR error payload');
  return writeGeminiGenerateContentError(status, new Headers({ 'x-upstream': 'a' }), payload);
};

test.each([503])('keeps upstream HTTP %i with its native RPC status', status => {
  const result = writeFrom(status, { error: { message: 'upstream unavailable' } });
  assertEquals(result.status, status);
  assertEquals(decoded(result).error.code, status);
  assertEquals(decoded(result).error.status, 'UNAVAILABLE');
  assertEquals(decoded(result).error.message, 'upstream unavailable');
});

test('keeps a status the inferred table would have flattened', () => {
  const result = writeFrom(402, { error: { message: 'payment required' } });

  assertEquals(result.status, 402);
  assertEquals(decoded(result).error.code, 402);
  assertEquals(decoded(result).error.status, 'UNKNOWN');
});
