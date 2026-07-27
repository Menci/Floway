import { expect, test } from 'vitest';

import { DEFAULT_RERANK_PATHS } from '../../src/rerank/default-paths.ts';

test('canonical paths keep compatible and native DashScope protocols distinct', () => {
  expect(DEFAULT_RERANK_PATHS).toEqual({
    'cohere-v1': '/v1/rerank',
    'cohere-v2': '/v2/rerank',
    'jina-v1': '/v1/rerank',
    'voyage-v1': '/v1/rerank',
    'dashscope-compatible': '/compatible-api/v1/reranks',
    'dashscope-native': '/api/v1/services/rerank/text-rerank/text-rerank',
  });
});
