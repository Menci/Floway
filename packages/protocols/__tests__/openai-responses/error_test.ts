import { expect, test } from 'vitest';

import { formatOpenAIResponsesError } from '../../src/openai-responses/error.ts';

test('formats the Responses error event when no response resource exists', () => {
  expect(formatOpenAIResponsesError(502, 'upstream failure')).toEqual({ type: 'error', message: 'upstream failure' });
});
