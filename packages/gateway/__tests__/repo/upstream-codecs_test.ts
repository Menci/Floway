import { expect, test } from 'vitest';

import {
  decodeUpstreamModel,
  encodeUpstreamModel,
} from '../../src/repo/upstream-codecs.ts';
import type { ProviderModel } from '@floway-dev/provider';

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
