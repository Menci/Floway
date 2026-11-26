import { expect, test } from 'vitest';

import {
  decodeCustomDiscoveredModels,
  decodeUpstreamModel,
  encodeCustomDiscoveredModels,
  encodeUpstreamModel,
} from '../../src/repo/upstream-codecs.ts';
import type { ProviderModel, UpstreamModelConfig } from '@floway-dev/provider';

test('custom discovered codec preserves Custom editor discovery outside the routable catalog', () => {
  const discovered: UpstreamModelConfig[] = [{
    upstreamModelId: 'rerank-only',
    publicModelId: 'rerank-only',
    kind: 'rerank',
    endpoints: { rerank: {} },
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
  }];
  expect(decodeCustomDiscoveredModels(encodeCustomDiscoveredModels(discovered), 'up_custom')).toEqual(discovered);
});

test('stored model codec round-trips a decision target and enabledFlags Set', () => {
  const model: ProviderModel = {
    id: 'decision-1',
    upstreamModelId: 'decision-1',
    kind: 'decision',
    limits: {},
    endpoints: { decision: {} },
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
    enabledFlags: new Set(['vendor-kimi'] as const),
    decisionTarget: { protocol: 'typesafe-systemone', path: '/providers/microsoft/v1/systemone' },
  };
  expect(decodeUpstreamModel(encodeUpstreamModel(model), 'up_azure')).toEqual(model);
});
