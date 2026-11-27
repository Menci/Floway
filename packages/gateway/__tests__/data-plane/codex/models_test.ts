import { describe, expect, test } from 'vitest';

import { assembleCodexCatalog } from '../../../src/data-plane/codex/models.ts';
import type { AddressableIdEntry } from '../../../src/data-plane/shared/listing/addressable.ts';
import type { CatalogUpstreamMeta } from '../../../src/data-plane/upstreams/catalog.ts';
import { stubUpstreamModel } from '@floway-dev/test-utils';
import type { InternalModel } from '@floway-dev/upstream';

const meta = (id: string, kind: CatalogUpstreamMeta['kind']): CatalogUpstreamMeta => ({
  id,
  kind,
  name: id,
  hue: 210,
});

const bundled = {
  models: [
    // Catalog entries carry user-facing service-tier metadata. Floway exposes
    // only registry-priced ids while preserving these names and descriptions.
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, priority: 1, visibility: 'list', extra: 'keep', service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }] },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, priority: 2, visibility: 'list', service_tiers: [{ id: 'priority', name: 'Accelerated', description: 'Model-specific speed tier' }] },
  ],
};

const chat = (id: string, displayName?: string, ctx = 100000): InternalModel => ({
  id,
  ...(displayName === undefined ? {} : { display_name: displayName }),
  kind: 'chat',
  limits: { max_context_window_tokens: ctx },
  endpoints: { openaiChatCompletions: {} },
});

const entry = (
  model: InternalModel,
  unlisted?: true,
  contributions: AddressableIdEntry['contributions'] = [],
): AddressableIdEntry => ({
  id: model.id,
  unlisted,
  model,
  upstreams: contributions.map(c => c.upstream),
  contributions,
});

const entries = (...models: InternalModel[]): AddressableIdEntry[] => models.map(m => entry(m));

describe('assembleCodexCatalog', () => {
  test('uses the primary ChatGPT provider default for a prefixed model without a matching client entry', () => {
    const provider = meta('primary', 'chatgpt');
    const model = chat('codex/future-model', 'Future', 600000);
    const out = assembleCodexCatalog(bundled, [entry(model, undefined, [{
      upstream: provider,
      model: stubUpstreamModel({
        limits: { max_context_window_tokens: 600000 },
        upstreamData: { contextWindow: 80000, useResponsesLite: false },
      }),
    }])]);
    expect(out.models[0]).toMatchObject({ slug: 'codex/future-model', context_window: 80000, max_context_window: 600000 });
  });

  test('a secondary ChatGPT provider cannot replace the primary provider budget', () => {
    const primary = meta('primary', 'copilot');
    const secondary = meta('secondary', 'chatgpt');
    const model = chat('gpt-5.5', 'Primary', 200000);
    const out = assembleCodexCatalog(bundled, [entry(model, undefined, [
      { upstream: primary, model: stubUpstreamModel({ limits: { max_context_window_tokens: 200000 } }) },
      {
        upstream: secondary,
        model: stubUpstreamModel({
          limits: { max_context_window_tokens: 872000 },
          upstreamData: { contextWindow: 272000, useResponsesLite: false },
        }),
      },
    ])]);
    expect(out.models[0]).toMatchObject({ context_window: 200000, max_context_window: 200000 });
  });

  test.each([
    { codex: {}, expected: [] },
    { codex: { service_tiers: [], additional_speed_tiers: ['fast'] }, expected: [] },
    { codex: { additional_speed_tiers: ['fast'] }, expected: ['priority'] },
    { codex: { service_tiers: [{ id: 'ultrafast', name: 'Ultrafast', description: '' }] }, expected: ['ultrafast'] },
  ])('only lists tiers shared with the ChatGPT catalog $codex, in either routing order', ({ codex, expected }) => {
    const native = meta('native', 'custom');
    const subscription = meta('subscription', 'chatgpt');
    const pricing = { entries: ['priority', 'ultrafast'].map(serviceTier => ({ selector: { serviceTier }, rates: { input_tokens: '1' } })) };
    const model: InternalModel = { ...chat('shared'), pricing };
    const nativeContrib = { upstream: native, model: stubUpstreamModel({ pricing, endpoints: { openaiResponses: {} } }) };
    const subContrib = { upstream: subscription, model: stubUpstreamModel({ upstreamData: { contextWindow: 100000, codex } }) };
    for (const contributions of [[nativeContrib, subContrib], [subContrib, nativeContrib]]) {
      const [row] = assembleCodexCatalog(bundled, [entry(model, undefined, contributions)]).models;
      expect(row.service_tiers?.map(tier => tier.id)).toEqual(expected);
      expect(row.additional_speed_tiers).toEqual(expected.some(id => id === 'priority') ? ['fast'] : []);
    }
    const unpricedNative = { upstream: native, model: stubUpstreamModel({ endpoints: { openaiResponses: {} } }) };
    expect(assembleCodexCatalog(bundled, [entry(model, undefined, [subContrib, unpricedNative])]).models[0].service_tiers).toEqual([]);
  });

  test('leaf-first segment match: trailing leaf beats colliding earlier segments', () => {
    // `openrouter/gpt-5.5/gpt-5.4` binds against gpt-5.4 — walking segments
    // leaf-first avoids binding against an earlier segment (`gpt-5.5`) that
    // happens to collide with a bundled slug.
    const out = assembleCodexCatalog(bundled, entries(chat('openrouter/gpt-5.5/gpt-5.4')));
    expect(out.models[0].priority).toBe(2);  // gpt-5.4's priority
  });

  test('non-chat models and unlisted addressable entries are dropped', () => {
    // A model reachable only via `modelPrefix.addressable` alternates (not
    // listed on /v1/models) also stays off the codex picker — the operator
    // opted out of the default listing surface on that side too.
    const out = assembleCodexCatalog(bundled, [
      entry({ id: 'text-embedding-3', display_name: 'emb', kind: 'embedding', limits: {}, endpoints: {} } as InternalModel),
      entry(chat('gpt-5.5'), true),
      entry(chat('gpt-5.4')),
    ]);
    expect(out.models.map(m => m.slug)).toEqual(['gpt-5.4']);
  });

  test('bundled reuse: registry pricing.entries selects and preserves bundled service-tier metadata', () => {
    const im: InternalModel = {
      ...chat('openrouter/gpt-5.5:nitro'),
      pricing: { entries: [{ rates: { input_tokens: '1' } }, { selector: { serviceTier: 'priority' }, rates: { input_tokens: '1' } }] },
    };
    const out = assembleCodexCatalog(bundled, entries(im));
    expect(out.models[0].service_tiers).toEqual([{ id: 'priority', name: 'Fast', description: '1.5x speed' }]);
  });

  test('unmatched model reuses service-tier metadata from another catalog model', () => {
    const im: InternalModel = {
      ...chat('custom-model'),
      pricing: { entries: [{ rates: { input_tokens: '1' } }, { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } }] },
    };
    const out = assembleCodexCatalog(bundled, entries(im));
    expect(out.models[0].service_tiers).toEqual([{ id: 'priority', name: 'Fast', description: '1.5x speed' }]);
  });
});
