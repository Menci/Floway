import { describe, expect, test } from 'vitest';

import type { CodexCatalogCapabilities } from './catalog.ts';
import { assembleCatalog } from './models.ts';
import type { AddressableIdEntry } from '../shared/listing/addressable.ts';
import type { InternalModel } from '@floway-dev/provider';

const bundled = {
  models: [
    // Bundled entries seeded with a non-empty `service_tiers` so the
    // "hard override" assertion below (registry pricing.entries replaces
    // bundled) is an end-to-end proof rather than a `[] === []` no-op.
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, priority: 1, visibility: 'list', extra: 'keep', service_tiers: [{ id: 'auto', name: 'auto', description: '' }] },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, priority: 2, visibility: 'list', service_tiers: [{ id: 'auto', name: 'auto', description: '' }] },
  ],
};

const chat = (id: string, displayName?: string, ctx = 100000): InternalModel => ({
  id,
  display_name: displayName,
  kind: 'chat',
  limits: { max_context_window_tokens: ctx },
  endpoints: { chatCompletions: {} },
  providerModels: {},
});

const entry = (model: InternalModel, unlisted?: true): AddressableIdEntry => ({
  id: model.id,
  unlisted,
  model,
  upstreams: [],
});

const entries = (...models: InternalModel[]): AddressableIdEntry[] => models.map(m => entry(m));

const ultraCapabilities: CodexCatalogCapabilities = {
  ultraReasoningLevel: { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
};

describe('assembleCatalog', () => {
  test('bundled match: reuses bundled entry, slug=publicId, display_name from registry', () => {
    const out = assembleCatalog(bundled, entries(chat('gpt-5.5', 'Custom Display Name', 200000)));
    expect(out.models).toHaveLength(1);
    const e = out.models[0];
    expect(e.slug).toBe('gpt-5.5');
    expect(e.display_name).toBe('Custom Display Name');
    expect(e.context_window).toBe(200000);   // registry max_context_window_tokens overrides bundled
    expect(e.priority).toBe(1);
    expect((e as Record<string, unknown>).extra).toBe('keep');  // arbitrary bundled fields stay
  });

  test('bundled match: registry display_name=undefined preserves the bundled display_name', () => {
    const out = assembleCatalog(bundled, entries(chat('gpt-5.5')));     // chat() passes display_name: undefined
    expect(out.models).toHaveLength(1);
    expect(out.models[0].display_name).toBe('GPT-5.5');         // bundled's display_name
  });

  test('segment match via prefix and suffix', () => {
    const out = assembleCatalog(bundled, entries(
      chat('openrouter/gpt-5.5:nitro'),
      chat('azure/gpt-5.4'),
    ));
    expect(out.models.map(m => m.slug)).toEqual(['openrouter/gpt-5.5:nitro', 'azure/gpt-5.4']);
    expect(out.models[0].priority).toBe(1);
    expect(out.models[1].priority).toBe(2);
  });

  test('multi-segment model-prefix publicId still bundle-matches via the trailing leaf', () => {
    // The model-prefix feature (packages/provider/src/model-prefix.ts) lets
    // operators republish an upstream model under a path-shaped prefix —
    // `openrouter/gpt-5.5`, `vendor/sub/region/gpt-5.5`. By the time the
    // public id reaches assembleCatalog the prefix is already baked in, so
    // bundle-matching falls out of the segment splitter: the publicId is
    // split on `/` (model-prefix segments) and `:` (OpenRouter-style
    // `:variant` suffixes), and the segments are walked leaf-first against
    // the bundled slug map — the trailing model slug is tried first.
    const out = assembleCatalog(bundled, entries(chat('vendor/sub/region/gpt-5.5', 'Sub-region GPT-5.5', 200000)));
    expect(out.models).toHaveLength(1);
    const e = out.models[0];
    expect(e.slug).toBe('vendor/sub/region/gpt-5.5');   // slug overridden to the prefixed publicId
    expect(e.display_name).toBe('Sub-region GPT-5.5');
    expect(e.priority).toBe(1);                          // priority comes from bundled gpt-5.5
    expect((e as Record<string, unknown>).extra).toBe('keep');
  });

  test('multiple bundled-matching ids of the same bundled slug coexist', () => {
    const out = assembleCatalog(bundled, entries(chat('gpt-5.5'), chat('openrouter/gpt-5.5:nitro')));
    expect(out.models).toHaveLength(2);
    expect(out.models.every(m => m.priority === 1)).toBe(true);
  });

  test('leaf-first segment match: trailing leaf beats colliding earlier segments', () => {
    // `openrouter/gpt-5.5/gpt-5.4` binds against gpt-5.4 — walking segments
    // leaf-first avoids binding against an earlier segment (`gpt-5.5`) that
    // happens to collide with a bundled slug.
    const out = assembleCatalog(bundled, entries(chat('openrouter/gpt-5.5/gpt-5.4')));
    expect(out.models[0].priority).toBe(2);  // gpt-5.4's priority
  });

  test('no match: synthesizes a new entry', () => {
    const out = assembleCatalog(bundled, entries(chat('deepseek-v4-pro', 'DeepSeek V4 Pro', 128000)));
    expect(out.models).toHaveLength(1);
    const e = out.models[0];
    expect(e.slug).toBe('deepseek-v4-pro');
    expect(e.display_name).toBe('DeepSeek V4 Pro');
    expect(e.context_window).toBe(128000);
    expect(e.shell_type).toBe('shell_command');     // hardcoded baseline
    expect(e.prefer_websockets).toBe(true);
  });

  test('threads exact-client Ultra capability into Max-capable synthesized entries', () => {
    const maxModel: InternalModel = {
      ...chat('deepseek-v4-pro'),
      chat: { reasoning: { effort: { supported: ['high', 'max'], default: 'high' } } },
    };
    const withoutCapability = assembleCatalog(bundled, entries(maxModel));
    const withCapability = assembleCatalog(bundled, entries(maxModel), ultraCapabilities);

    expect(withoutCapability.models[0].supported_reasoning_levels).toEqual([
      { effort: 'high', description: '' },
      { effort: 'max', description: '' },
    ]);
    expect(withoutCapability.models[0].multi_agent_version).toBeUndefined();
    expect(withCapability.models[0].supported_reasoning_levels).toEqual([
      { effort: 'high', description: '' },
      { effort: 'max', description: '' },
      { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
    ]);
    expect(withCapability.models[0].multi_agent_version).toBe('v2');
  });

  test('non-chat models are dropped', () => {
    const out = assembleCatalog(bundled, [
      entry({ id: 'text-embedding-3', display_name: 'emb', kind: 'embedding', limits: {}, endpoints: {} } as InternalModel),
      entry(chat('gpt-5.5')),
    ]);
    expect(out.models).toHaveLength(1);
    expect(out.models[0].slug).toBe('gpt-5.5');
  });

  test('unlisted addressable entries are dropped', () => {
    // A model reachable only via `modelPrefix.addressable` alternates (not
    // listed on /v1/models) also stays off the codex picker — the operator
    // opted out of the default listing surface on that side too.
    const out = assembleCatalog(bundled, [
      entry(chat('gpt-5.5'), true),
      entry(chat('gpt-5.4')),
    ]);
    expect(out.models.map(m => m.slug)).toEqual(['gpt-5.4']);
  });

  test('bundled reuse: registry pricing.entries replaces bundled service_tiers', () => {
    const im: InternalModel = {
      ...chat('openrouter/gpt-5.5:nitro'),
      pricing: { entries: [{ rates: { input_tokens: '1' } }, { selector: { serviceTier: 'fast' }, rates: { input_tokens: '1' } }] },
    };
    const out = assembleCatalog(bundled, entries(im));
    expect(out.models[0].service_tiers).toEqual([{ id: 'fast', name: 'fast', description: '' }]);
  });

  test('bundled reuse: no registry pricing.entries yields service_tiers: []', () => {
    const out = assembleCatalog(bundled, entries(chat('openrouter/gpt-5.5:nitro')));
    expect(out.models[0].service_tiers).toEqual([]);
  });
});
