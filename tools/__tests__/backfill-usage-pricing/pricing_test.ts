import { test } from 'vitest';

import { resolveUsagePricing, type StoredUpstream } from '../../src/backfill-usage-pricing/pricing.ts';
import { MODEL_CATALOG_REVISION } from '@floway-dev/gateway';
import { basePricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const upstream = (provider: string, config: unknown, modelsCache: unknown = null): StoredUpstream => ({
  id: `${provider}-1`,
  provider,
  configJson: JSON.stringify(config),
  modelsCacheJson: modelsCache === null ? null : JSON.stringify(modelsCache),
});

test('custom fetched pricing requires a current catalog with matching model identity', () => {
  const pricing = basePricing({ input_tokens: '0.02' });
  const cache = {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.UTC(2026, 0, 1),
    models: [{ id: 'public', providerData: 'wire', pricing }],
  };
  const resolved = resolveUsagePricing(
    upstream('custom', { models: [] }, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 1, 1),
  );
  assertEquals(resolved.status, 'priced');
  assertEquals(resolveUsagePricing(
    upstream('custom', { models: [] }, cache),
    { model: 'public', modelKey: 'different' },
    Date.UTC(2026, 0, 1, 1),
  ).status, 'unavailable');
  assertEquals(resolveUsagePricing(
    upstream('custom', { models: [] }, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 3),
  ).status, 'unavailable');
});

test('custom disabled model fetching does not reuse cached pricing', () => {
  const cache = {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.UTC(2026, 0, 1),
    models: [{ id: 'public', providerData: 'wire', pricing: basePricing({ input_tokens: '0.02' }) }],
  };
  const resolved = resolveUsagePricing(
    upstream('custom', {
      modelsFetch: { enabled: false },
      models: [{ kind: 'chat', endpoints: { openaiResponses: {} }, upstreamModelId: 'wire' }],
    }, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 1, 1),
  );
  assertEquals(resolved.status, 'unpriced');
});
