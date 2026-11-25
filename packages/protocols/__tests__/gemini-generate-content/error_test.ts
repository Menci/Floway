import { expect, test } from 'vitest';

import { formatGeminiGenerateContentError } from '../../src/gemini-generate-content/error.ts';

test.each([
  [429, 429, 'RESOURCE_EXHAUSTED'],
  [418, 418, 'UNKNOWN'],
  [null, 500, 'INTERNAL'],
])('formats the Gemini error envelope for HTTP status %s', (upstreamStatus, code, status) => {
  expect(formatGeminiGenerateContentError(upstreamStatus, 'upstream failure')).toEqual({
    error: { code, status, message: 'upstream failure' },
  });
});
