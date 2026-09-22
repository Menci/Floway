import { test } from 'vitest';

import { ratesForStoredSelector, resolveUsagePricing, type StoredUpstream } from '../../src/backfill-usage-pricing/pricing.ts';
import { MODEL_CATALOG_REVISION } from '@floway-dev/gateway';
import { basePricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const upstream = (provider: string, config: unknown, modelsCache: unknown = null): StoredUpstream => ({
  id: `${provider}-1`,
  provider,
  configJson: JSON.stringify(config),
  modelsCacheJson: modelsCache === null ? null : JSON.stringify(modelsCache),
});

const manual = (upstreamModelId: string, pricing = basePricing({ input_tokens: '0.01' })) => ({
  kind: 'chat',
  endpoints: { openaiResponses: {} },
  upstreamModelId,
  pricing,
});

test('configured pricing and provider pricing resolve through their owning sources', () => {
  const azure = resolveUsagePricing(upstream('azure', { models: [manual('deployment')] }), { model: 'public', modelKey: 'deployment' });
  assertEquals(azure.status, 'priced');
  assertEquals(azure.status === 'priced' ? azure.pricing.entries[0]?.rates.input_tokens : null, '0.01');

  assertEquals(resolveUsagePricing(upstream('codex', {}), { model: 'gpt-5.4', modelKey: 'gpt-5.4' }).status, 'priced');
  assertEquals(resolveUsagePricing(upstream('claude-code', {}), { model: 'claude-sonnet-4-6', modelKey: 'claude-sonnet-4-6' }).status, 'priced');
  assertEquals(resolveUsagePricing(upstream('copilot', {}), { model: 'gpt-5.4', modelKey: 'gpt-5.4' }).status, 'priced');
  assertEquals(resolveUsagePricing(upstream('ollama', { models: [] }), { model: 'gpt-oss:120b', modelKey: 'gpt-oss:120b' }).status, 'priced');
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

test('selector lookup falls back to the whole Base vector without merging fields', () => {
  const pricing = basePricing({ input_tokens: '0.01' });
  assertEquals(ratesForStoredSelector(pricing, '{"serviceTier":"priority"}'), {
    exact: false,
    rates: { input_tokens: '0.01' },
  });
});
