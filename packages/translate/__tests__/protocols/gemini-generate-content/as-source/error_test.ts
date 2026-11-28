import { test } from 'vitest';

import { geminiGenerateContentErrorFromIR } from '../../../../src/protocols/gemini-generate-content/as-source/error.ts';
import { assertEquals } from '@floway-dev/test-utils';

test.each([503])('keeps upstream HTTP %i with its native RPC status', status => {
  const error = geminiGenerateContentErrorFromIR({ message: 'upstream unavailable' }, status);
  assertEquals(error.code, status);
  assertEquals(error.status, 'UNAVAILABLE');
  assertEquals(error.message, 'upstream unavailable');
});

test('keeps a status the inferred table would have flattened', () => {
  const error = geminiGenerateContentErrorFromIR({ message: 'payment required' }, 402);

  assertEquals(error.code, 402);
  assertEquals(error.status, 'UNKNOWN');
});
