import { expect, test } from 'vitest';

import { DEFAULT_DECISION_PATHS } from '../../src/decision/default-paths.ts';

test('canonical paths keep the two decision dialects distinct', () => {
  expect(DEFAULT_DECISION_PATHS).toEqual({
    'systemone': '/v1/systemone',
    'openai-decisions': '/v1/decisions',
  });
});
