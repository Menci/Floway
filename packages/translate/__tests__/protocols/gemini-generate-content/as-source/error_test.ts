import { test } from 'vitest';

import { geminiGenerateContentErrorFromIR } from '../../../../src/protocols/gemini-generate-content/as-source/error.ts';
import { irErrorPayloadFromBody } from '../../../../src/shared/api-error.ts';
import { assertEquals } from '@floway-dev/test-utils';

const errorFrom = (status: number, body: unknown) => {
  const payload = irErrorPayloadFromBody(new TextEncoder().encode(JSON.stringify(body)));
  if (payload === undefined) throw new Error('Expected parsed IR error payload');
  return geminiGenerateContentErrorFromIR(payload, status);
};

test.each([503])('keeps upstream HTTP %i with its native RPC status', status => {
  const error = errorFrom(status, { error: { message: 'upstream unavailable' } });
  assertEquals(error.code, status);
  assertEquals(error.status, 'UNAVAILABLE');
  assertEquals(error.message, 'upstream unavailable');
});

test('keeps a status the inferred table would have flattened', () => {
  const error = errorFrom(402, { error: { message: 'payment required' } });

  assertEquals(error.code, 402);
  assertEquals(error.status, 'UNKNOWN');
});
