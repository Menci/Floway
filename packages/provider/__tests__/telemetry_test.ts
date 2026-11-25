import { expect, test } from 'vitest';

import { parsePerformanceOperation } from '../src/telemetry.ts';

test.each(['audio_speech', 'count_tokens', 'alpha_search'] as const)('recognizes the performance operation %s', operation => {
  expect(parsePerformanceOperation(operation)).toBe(operation);
});
