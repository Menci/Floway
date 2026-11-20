import { test } from 'vitest';

import { providerModelOf } from '../src/invocation.ts';
import { assertThrows, stubModelCandidate } from '@floway-dev/test-utils';

test('providerModelOf throws when the candidate names an upstream missing from providerModels', () => {
  const candidate = stubModelCandidate({
    model: {
      id: 'orphan-model',
      providerModels: {},
    },
  });

  assertThrows(() => providerModelOf(candidate), Error);
});
