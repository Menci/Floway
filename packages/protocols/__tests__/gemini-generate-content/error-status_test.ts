import { expect, test } from 'vitest';

import { geminiGenerateContentStatusForHttpStatus } from '../../src/gemini-generate-content/index.ts';

test('known HTTP codes have protocol status names while unmapped codes have no policy default', () => {
  expect(geminiGenerateContentStatusForHttpStatus(400)).toBe('INVALID_ARGUMENT');
  expect(geminiGenerateContentStatusForHttpStatus(408)).toBe('DEADLINE_EXCEEDED');
  expect(geminiGenerateContentStatusForHttpStatus(502)).toBe('UNAVAILABLE');
  expect(geminiGenerateContentStatusForHttpStatus(599)).toBeUndefined();
});
