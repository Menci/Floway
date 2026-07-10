import { describe, expect, test } from 'vitest';

import { assembleCatalog } from './models.ts';
import type { AddressableIdEntry } from '../shared/listing/addressable.ts';
import type { InternalModel } from '@floway-dev/provider';

const bundled = {
  models: [
    // Bundled entries seeded with a non-empty `service_tiers` so the
    // "hard override" assertion below (registry cost.tiers replaces
    // bundled) is an end-to-end proof rather than a `[] === []` no-op.
    // Priorities mirror the real catalog's sparse numbering so the
    // native-first banding (variants/unrelated sit strictly above the max
    // native priority) is visible rather than coinciding with 1, 2, ….
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, priority: 7, visibility: 'list', extra: 'keep', service_tiers: [{ id: 'auto', name: 'auto', description: '' }] },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, priority: 16, visibility: 'list', service_tiers: [{ id: 'auto', name: 'auto', description: '' }] },
    // A hidden bundled GPT entry: an exact or variant match must still
    // surface, with visibility forced to 'list' and supported_in_api forced
    // true.
    { slug: 'gpt-hidden', display_name: 'GPT Hidden', context_window: 272000, priority: 20, visibility: 'hide', supported_in_api: false },
    // A non-GPT bundled slug: even an exact whole-id match ranks as
    // unrelated, never native. Hidden too, so it doubles as a
    // visibility-forcing case.
    { slug: 'codex-auto-review', display_name: 'Auto Review', context_window: 272000, priority: 43, visibility: 'hide', supported_in_api: false },
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

const slugsWithPriority = (out: { models: { slug: string; priority?: unknown }[] }): [string, unknown][] =>
  out.models.map(m => [m.slug, m.priority]);

describe('assembleCatalog', () => {
  test('exact bundled match: reuses bundled entry, slug=publicId, display_name from registry, native priority preserved', () => {
    const out = assembleCatalog(bundled, entries(chat('gpt-5.5', 'Custom Display Name', 200000)));
    expect(out.models).toHaveLength(1);
    const e = out.models[0];
    expect(e.slug).toBe('gpt-5.5');
    expect(e.display_name).toBe('Custom Display Name');
    expect(e.context_window).toBe(200000);   // registry max_context_window_tokens overrides bundled
    expect(e.priority).toBe(7);               // exact GPT match keeps the bundled priority
    expect((e as Record<string, unknown>).extra).toBe('keep');  // arbitrary bundled fields stay
  });

  test('exact bundled match: registry display_name=undefined preserves the bundled display_name', () => {
    const out = assembleCatalog(bundled, entries(chat('gpt-5.5')));     // chat() passes display_name: undefined
    expect(out.models).toHaveLength(1);
    expect(out.models[0].display_name).toBe('GPT-5.5');         // bundled's display_name
  });

  test('multi-segment model-prefix publicId bundle-matches via the trailing leaf (variant class)', () => {
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
    expect((e as Record<string, unknown>).extra).toBe('keep');   // inherits bundled gpt-5.5's fields
  });

  test('leaf-first segment match: trailing leaf beats colliding earlier segments', () => {
    // `openrouter/gpt-5.5/gpt-5.4` binds against gpt-5.4 — walking segments
    // leaf-first avoids binding against an earlier segment (`gpt-5.5`) that
    // happens to collide with a bundled slug. Proven through the inherited
    // fields: gpt-5.4's label rides through and gpt-5.5's `extra` does not.
    const out = assembleCatalog(bundled, entries(chat('openrouter/gpt-5.5/gpt-5.4')));
    expect(out.models[0].display_name).toBe('GPT-5.4');
    expect((out.models[0] as Record<string, unknown>).extra).toBeUndefined();
  });

  test('exact natives keep bundled priority; a same-slug variant ranks directly after them', () => {
    const out = assembleCatalog(bundled, entries(chat('gpt-5.5'), chat('openrouter/gpt-5.5:nitro')));
    expect(slugsWithPriority(out)).toEqual([
      ['gpt-5.5', 7],                    // exact native: bundled priority
      ['openrouter/gpt-5.5:nitro', 8],   // variant: one above the max native priority
    ]);
  });

  test('variants rank after every native, sorted by base priority then public id', () => {
    const out = assembleCatalog(bundled, entries(
      chat('gpt-5.5'),            // exact native, priority 7
      chat('gpt-5.4'),            // exact native, priority 16 (max native)
      chat('b/gpt-5.4'),          // variant of gpt-5.4 (base priority 16)
      chat('a/gpt-5.5:x'),        // variant of gpt-5.5 (base priority 7)
    ));
    expect(slugsWithPriority(out)).toEqual([
      ['gpt-5.5', 7],
      ['gpt-5.4', 16],
      ['a/gpt-5.5:x', 17],   // lower base priority sorts first among variants
      ['b/gpt-5.4', 18],
    ]);
  });

  test('unrelated models rank after all variants, sorted by public id', () => {
    const out = assembleCatalog(bundled, entries(
      chat('openrouter/gpt-5.5:nitro'),   // variant, base priority 7
      chat('zeta-model'),                 // unrelated
      chat('alpha-model'),                // unrelated
    ));
    expect(slugsWithPriority(out)).toEqual([
      ['openrouter/gpt-5.5:nitro', 1],   // no natives → variant band starts at 1
      ['alpha-model', 2],                // unrelated, id-sorted
      ['zeta-model', 3],
    ]);
  });

  test('non-GPT exact bundled match is unrelated, ranking after GPT variants', () => {
    // codex-auto-review is an exact bundled slug, but a non-GPT one: it is
    // never native. It still inherits the bundled entry's fields as its base,
    // yet ranks in the unrelated band below every gpt variant.
    const out = assembleCatalog(bundled, entries(
      chat('openrouter/gpt-5.5:nitro'),   // variant
      chat('codex-auto-review'),          // exact non-GPT bundled slug → unrelated
    ));
    expect(slugsWithPriority(out)).toEqual([
      ['openrouter/gpt-5.5:nitro', 1],
      ['codex-auto-review', 2],
    ]);
    const autoReview = out.models[1];
    expect(autoReview.display_name).toBe('Auto Review');   // bundled base still inherited
    expect(autoReview.visibility).toBe('list');            // hidden bundled state does not leak
    expect(autoReview.supported_in_api).toBe(true);
  });

  test('every surfaced chat entry is listed and API-supported even when its bundled source hides it', () => {
    const out = assembleCatalog(bundled, entries(
      chat('gpt-hidden'),           // exact native, bundled visibility 'hide'
      chat('vendor/gpt-hidden'),    // variant of a hidden bundled entry
      chat('codex-auto-review'),    // non-GPT, hidden bundled entry
      chat('some-unknown'),         // synthesized from scratch
    ));
    expect(out.models.every(m => m.visibility === 'list')).toBe(true);
    expect(out.models.every(m => m.supported_in_api === true)).toBe(true);
  });

  test('synthesized priorities and array order are deterministic across input order', () => {
    const models = [
      chat('gpt-5.5'),
      chat('gpt-5.4'),
      chat('openrouter/gpt-5.5:nitro'),
      chat('azure/gpt-5.4'),
      chat('deepseek-v4-pro'),
      chat('codex-auto-review'),
      chat('aardvark-x'),
    ];
    const forward = assembleCatalog(bundled, models.map(m => entry(m)));
    const reversed = assembleCatalog(bundled, [...models].reverse().map(m => entry(m)));
    const shuffled = assembleCatalog(bundled, [3, 0, 6, 1, 5, 2, 4].map(i => entry(models[i])));
    expect(reversed.models).toEqual(forward.models);
    expect(shuffled.models).toEqual(forward.models);
    // And the deterministic order is native-first, then variants, then
    // unrelated (id-sorted within each band).
    expect(forward.models.map(m => m.slug)).toEqual([
      'gpt-5.5',                    // native, priority 7
      'gpt-5.4',                    // native, priority 16
      'openrouter/gpt-5.5:nitro',   // variant of gpt-5.5 (base 7)
      'azure/gpt-5.4',              // variant of gpt-5.4 (base 16)
      'aardvark-x',                 // unrelated, id-sorted
      'codex-auto-review',
      'deepseek-v4-pro',
    ]);
  });

  test('registry effort metadata makes the entry advertise reasoning summaries and forwards the effort values', () => {
    const im: InternalModel = {
      ...chat('gpt-5.5'),
      chat: { reasoning: { effort: { supported: ['low', 'high'], default: 'high' } } },
    };
    const out = assembleCatalog(bundled, entries(im));
    const e = out.models[0];
    expect(e.supports_reasoning_summaries).toBe(true);
    expect(e.supported_reasoning_levels).toEqual([
      { effort: 'low', description: '' },
      { effort: 'high', description: '' },
    ]);
    expect(e.default_reasoning_level).toBe('high');
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

  test('bundled reuse: registry cost.tiers replaces bundled service_tiers', () => {
    const im: InternalModel = {
      ...chat('openrouter/gpt-5.5:nitro'),
      cost: { tiers: { fast: { input: 1 } } },
    };
    const out = assembleCatalog(bundled, entries(im));
    expect(out.models[0].service_tiers).toEqual([{ id: 'fast', name: 'fast', description: '' }]);
  });

  test('bundled reuse: no registry cost.tiers yields service_tiers: []', () => {
    const out = assembleCatalog(bundled, entries(chat('openrouter/gpt-5.5:nitro')));
    expect(out.models[0].service_tiers).toEqual([]);
  });
});
