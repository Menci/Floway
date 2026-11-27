import { test } from 'vitest';

import { validateOllamaManualModels } from '../src/config.ts';
import { assertThrows } from '@floway-dev/test-utils';

test('validateOllamaManualModels rejects rerank models', () => {
  assertThrows(
    () => validateOllamaManualModels([{
      upstreamModelId: 'reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }]),
    Error,
  );
});
