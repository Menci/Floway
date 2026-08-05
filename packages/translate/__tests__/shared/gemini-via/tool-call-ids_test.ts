import { test } from 'vitest';

import { geminiFunctionCallPart, geminiFunctionResponsePart, type GeminiToolCallIds } from '../../../src/shared/gemini-via/gemini.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('Gemini tool-call correlation accepts prototype-property function names', () => {
  const ids: GeminiToolCallIds = new Map();
  const call = geminiFunctionCallPart(
    { functionCall: { name: '__proto__', args: { value: 1 } } },
    ids,
    0,
    0,
  );
  const response = geminiFunctionResponsePart(
    { functionResponse: { name: '__proto__', response: { value: 1 } } },
    ids,
    1,
    0,
  );

  assertEquals(call?.id, 'gemini_call_0_0');
  assertEquals(response?.id, 'gemini_call_0_0');
  assertEquals(ids.size, 0);
});
