import { test } from 'vitest';

import { resolveUsagePricing, type StoredUpstream } from '../../src/backfill-usage-pricing/pricing.ts';
import { MODEL_CATALOG_REVISION } from '@floway-dev/gateway';
import { basePricing } from '@floway-dev/protocols/common';
import type { UpstreamModelConfig } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const upstream = (
  provider: string,
  config: unknown,
  opts: {
    manualModels?: readonly UpstreamModelConfig[];
    modelsCacheRevision?: number | null;
    modelsCacheFetchedAt?: number | null;
    cachedModel?: unknown;
  } = {},
): StoredUpstream => ({
  id: `${provider}-1`,
  provider,
  configJson: JSON.stringify(config),
  manualModels: opts.manualModels ?? [],
  modelsCacheRevision: opts.modelsCacheRevision ?? null,
  modelsCacheFetchedAt: opts.modelsCacheFetchedAt ?? null,
  cachedModelJson: opts.cachedModel === undefined ? null : JSON.stringify(opts.cachedModel),
});

test('custom fetched pricing requires a current catalog with matching model identity', () => {
  const pricing = basePricing({ input_tokens: '0.02' });
  const cache = {
    modelsCacheRevision: MODEL_CATALOG_REVISION,
    modelsCacheFetchedAt: Date.UTC(2026, 0, 1),
    cachedModel: { id: 'public', providerData: 'wire', pricing },
  };
  const resolved = resolveUsagePricing(
    upstream('custom', {}, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 1, 1),
  );
  assertEquals(resolved.status, 'priced');
  assertEquals(resolveUsagePricing(
    upstream('custom', {}, cache),
    { model: 'public', modelKey: 'different' },
    Date.UTC(2026, 0, 1, 1),
  ).status, 'unavailable');
  assertEquals(resolveUsagePricing(
    upstream('custom', {}, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 3),
  ).status, 'unavailable');
});

test('custom disabled model fetching does not reuse cached pricing', () => {
  const resolved = resolveUsagePricing(
    upstream('custom', {
      modelsFetch: { enabled: false },
    }, {
      manualModels: [{ kind: 'chat', endpoints: { openaiResponses: {} }, upstreamModelId: 'wire' }],
      modelsCacheRevision: MODEL_CATALOG_REVISION,
      modelsCacheFetchedAt: Date.UTC(2026, 0, 1),
      cachedModel: { id: 'public', providerData: 'wire', pricing: basePricing({ input_tokens: '0.02' }) },
    }),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 1, 1),
  );
  assertEquals(resolved.status, 'unpriced');
});
