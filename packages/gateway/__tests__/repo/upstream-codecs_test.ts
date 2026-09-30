import { expect, test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { decodeUpstreamModelsCache, encodeUpstreamModelsCache } from '../../src/repo/upstream-codecs.ts';
import type { UpstreamModelsCache } from '@floway-dev/provider';

test('stored model cache preserves Custom editor discovery outside the routable catalog', () => {
  const cache: UpstreamModelsCache = {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 100,
    models: [],
    discovered: [{
      upstreamModelId: 'rerank-only',
      publicModelId: 'rerank-only',
      kind: 'rerank',
      endpoints: { rerank: {} },
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    }],
    lastError: null,
  };
  expect(decodeUpstreamModelsCache(encodeUpstreamModelsCache(cache), 'up_custom')).toEqual(cache);
});

test('existing model caches without Custom discovery remain readable', () => {
  const cache: UpstreamModelsCache = { revision: MODEL_CATALOG_REVISION, fetchedAt: 100, models: [], lastError: null };
  expect(decodeUpstreamModelsCache(encodeUpstreamModelsCache(cache), 'up_existing')).toEqual(cache);
});
