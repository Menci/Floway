import { describe, expect, test } from 'vitest';

import type { AddressableIdEntry } from './addressable.ts';
import { synthesizeListedAliases } from './alias.ts';
import type { ModelAliasRecord } from '../../../repo/types.ts';
import type { InternalModel, ProviderModel } from '@floway-dev/provider';

const aliasFixture = (overrides: Partial<ModelAliasRecord> = {}): ModelAliasRecord => ({
  name: 'gpt-fast',
  kind: 'chat',
  selection: 'first-available',
  displayName: null,
  visibleInModelsList: true,
  targets: [{ target_model_id: 'gpt-5.4', rules: {} }],
  announcedMetadata: null,
  sortOrder: 0,
  createdAt: '2026-06-26T00:00:00.000Z',
  updatedAt: '2026-06-26T00:00:00.000Z',
  ...overrides,
});

const realModel = (
  overrides: Partial<Omit<InternalModel, 'aliasedFrom' | 'providerModels'>> & { id: string; providerModels?: Record<string, ProviderModel> },
): InternalModel => ({
  kind: 'chat',
  limits: {},
  endpoints: { chatCompletions: {}, messages: {}, responses: {} },
  providerModels: {},
  ...overrides,
});

// Adapt the fixtures' "list of real models" view to the addressable surface
// the synthesizer now consumes — every fixture entry is a listed catalog row.
const listed = (models: readonly InternalModel[]): AddressableIdEntry[] =>
  models.map(model => ({ id: model.id, unlisted: undefined, model, upstreams: [] }));

// Test-only addressable surface that pretends a model is reachable through
// a prefix-only addressable form. The synthesizer should treat such targets
// as available even though they never appear in the listed catalog.
const unlisted = (id: string, model: InternalModel): AddressableIdEntry => ({ id, unlisted: true, model, upstreams: [] });

describe('synthesizeListedAliases', () => {
  test('single-target alias with a pinned reasoning.effort drops the effort block', () => {
    const aliases = [aliasFixture({
      name: 'gpt-fast',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    })];
    const realModels = [realModel({
      id: 'gpt-5.4',
      display_name: 'GPT 5.4',
      chat: {
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
      },
    })];

    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.id).toBe('gpt-fast');
    expect(entry.display_name).toBe('gpt-5.4 (low effort)');
    // The rule pins effort, so the announced metadata drops it — the
    // caller already knows the value because the alias fixes it.
    expect(entry.chat?.reasoning).toBeUndefined();
    expect(entry.chat?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(entry.aliasedFrom).toEqual({
      selection: 'first-available',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    });
  });

  test('single-target alias with a pinned reasoning.budget_tokens drops the budget block', () => {
    const aliases = [aliasFixture({
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { budget_tokens: 4096 } } }],
    })];
    const realModels = [realModel({
      id: 'gpt-5.4',
      chat: { reasoning: { budget_tokens: { min: 1024, max: 65536 } } },
    })];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('multi-target alias drops budget_tokens when one target declares only min and another only max', () => {
    // A half-declared block (e.g. publishing `{ min }` without max) would
    // advertise a capability some target does not report. The intersection
    // must collapse to undefined, matching how `effort` / `adaptive` /
    // `mandatory` already behave.
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { budget_tokens: { min: 1024 } } } }),
      realModel({ id: 'b', chat: { reasoning: { budget_tokens: { max: 65536 } } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('multi-target alias intersects chat.modalities across every target', () => {
    const aliases = [aliasFixture({
      name: 'smart-router',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
      realModel({ id: 'b', chat: { modalities: { input: ['text'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.id).toBe('smart-router');
    expect(entry.display_name).toBe('smart-router');
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  test('multi-target intersection drops capabilities only one target declares', () => {
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { effort: { supported: ['low'], default: 'low' } } } }),
      realModel({ id: 'b', chat: {} }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('multi-target with disjoint output modalities omits the modalities block entirely', () => {
    // Both targets share text input but their output modalities do not
    // overlap. Advertising `{ input: ['text'], output: [] }` would claim a
    // chat model that consumes text and produces nothing — incoherent —
    // so the synthesizer omits the modalities block when either half of
    // the intersection collapses.
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { modalities: { input: ['text'], output: ['text'] } } }),
      realModel({ id: 'b', chat: { modalities: { input: ['text'], output: ['image'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.modalities).toBeUndefined();
  });

  test('multi-target with an unavailable target intersects over the available subset', () => {
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'gone', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
      realModel({ id: 'b', chat: { modalities: { input: ['text'], output: ['text', 'image'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
    // Every configured target — including the unavailable one — survives in aliasedFrom.
    expect(entry.aliasedFrom?.targets.map(t => t.target_model_id)).toEqual(['a', 'gone', 'b']);
  });

  test('hidden alias is not emitted', () => {
    const aliases = [aliasFixture({ visibleInModelsList: false })];
    const realModels = [realModel({ id: 'gpt-5.4' })];
    expect(synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false })).toEqual([]);
  });

  test('alias whose name collides with a real id is emitted (loadModels drops the duplicate real)', () => {
    const aliases = [aliasFixture({
      name: 'gpt-5.4',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    })];
    const realModels = [realModel({ id: 'gpt-5.4', display_name: 'GPT 5.4' })];
    const entries = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('gpt-5.4');
    expect(entries[0].aliasedFrom).toBeDefined();
  });

  test('no available targets means the alias is hidden from the listing (resolver still returns 404 for the alias itself)', () => {
    const aliases = [aliasFixture({
      name: 'orphan',
      targets: [{ target_model_id: 'missing', rules: {} }],
    })];
    expect(synthesizeListedAliases({ aliases, gatewayAddressableModelIds: [], callerAddressableModelIds: [], narrowTargets: false })).toEqual([]);
  });

  test('sorts entries by (sort_order, name) so listing order stays stable', () => {
    const aliases = [
      aliasFixture({ name: 'late', sortOrder: 1 }),
      aliasFixture({ name: 'mid-a', sortOrder: 0 }),
      aliasFixture({ name: 'mid-b', sortOrder: 0 }),
    ];
    const realModels = [realModel({ id: 'gpt-5.4' })];
    const ids = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false }).map(entry => entry.id);
    expect(ids).toEqual(['mid-a', 'mid-b', 'late']);
  });

  test('targets whose kind disagrees with the alias are not counted as available', () => {
    const aliases = [aliasFixture({
      kind: 'chat',
      targets: [
        { target_model_id: 'emb', rules: {} },
        { target_model_id: 'chat', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'emb', kind: 'embedding' }),
      realModel({ id: 'chat', chat: { modalities: { input: ['text'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    // Only the chat target backs the metadata — the embedding row never
    // enters the intersection / narrowing path.
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  test('operator-set display_name wins over the derived form', () => {
    const aliases = [aliasFixture({
      displayName: 'My Fast GPT',
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
    })];
    const realModels = [realModel({ id: 'gpt-5.4' })];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.display_name).toBe('My Fast GPT');
  });

  test('multi-target alias whose first target pins reasoning.effort drops the alias-wide effort block', () => {
    // The pinned target counts as unsupported for effort, so the
    // intersection collapses — effort never makes it onto the listing.
    const aliases = [aliasFixture({
      name: 'mixed',
      targets: [
        { target_model_id: 'a', rules: { reasoning: { effort: 'low' } } },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } } }),
      realModel({ id: 'b', chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('multi-target alias without rules intersects reasoning.effort across targets', () => {
    const aliases = [aliasFixture({
      name: 'unfixed',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } } }),
      realModel({ id: 'b', chat: { reasoning: { effort: { supported: ['medium', 'high'], default: 'medium' } } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.reasoning?.effort).toEqual({ supported: ['medium', 'high'], default: 'medium' });
  });

  test('rules.reasoning.adaptive=true at any target drops adaptive from the announced metadata', () => {
    const aliases = [aliasFixture({
      name: 'pinned-adaptive',
      targets: [
        { target_model_id: 'a', rules: { reasoning: { adaptive: true } } },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { reasoning: { adaptive: true } } }),
      realModel({ id: 'b', chat: { reasoning: { adaptive: true } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.reasoning).toBeUndefined();
  });

  test('limits intersection emits min across targets; absent when any target lacks the field', () => {
    const aliases = [aliasFixture({
      name: 'multi-limits',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', limits: { max_context_window_tokens: 128000, max_output_tokens: 16000 } }),
      realModel({ id: 'b', limits: { max_context_window_tokens: 200000 } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    // Both targets advertise max_context_window_tokens — emit the min.
    expect(entry.limits.max_context_window_tokens).toBe(128000);
    // Only `a` declares max_output_tokens, so it drops out.
    expect(entry.limits.max_output_tokens).toBeUndefined();
  });

  test('operator override pins limits.max_output_tokens; chat falls back to computed intersection', () => {
    const aliases = [aliasFixture({
      name: 'overridden',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
      announcedMetadata: {
        limits: { max_output_tokens: 8192 },
      },
    })];
    const realModels = [
      realModel({ id: 'a', limits: { max_context_window_tokens: 128000 }, chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
      realModel({ id: 'b', limits: { max_context_window_tokens: 200000 }, chat: { modalities: { input: ['text'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    // The override carries the operator's pinned ceiling verbatim …
    expect(entry.limits).toEqual({ max_output_tokens: 8192 });
    // … while chat falls back to the rule-aware intersection.
    expect(entry.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  test('operator override fully replaces chat when set, regardless of computed', () => {
    const aliases = [aliasFixture({
      name: 'chat-override',
      targets: [{ target_model_id: 'a', rules: {} }],
      announcedMetadata: {
        chat: { modalities: { input: ['text'], output: ['text'] } },
      },
    })];
    const realModels = [
      realModel({ id: 'a', chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat).toEqual({ modalities: { input: ['text'], output: ['text'] } });
  });

  test('endpoints is the union across available targets — every reachable endpoint surfaces', () => {
    const aliases = [aliasFixture({
      name: 'mixed',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      // Target a serves the three chat endpoints + /completions.
      realModel({ id: 'a', endpoints: { chatCompletions: {}, messages: {}, responses: {}, completions: {} } }),
      // Target b only serves the three chat endpoints.
      realModel({ id: 'b', endpoints: { chatCompletions: {}, messages: {}, responses: {} } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    // Union: every key surfaces. Resolver narrows to the supporting subset
    // at request time, so first-available / random stays sound per-endpoint.
    expect(entry.endpoints).toEqual({
      chatCompletions: {},
      messages: {},
      responses: {},
      completions: {},
    });
  });

  test('endpoints union surfaces both image keys when targets split between generations and edits', () => {
    const aliases = [aliasFixture({
      kind: 'image',
      targets: [
        { target_model_id: 'gen', rules: {} },
        { target_model_id: 'edit', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'gen', kind: 'image', endpoints: { imagesGenerations: {} } }),
      realModel({ id: 'edit', kind: 'image', endpoints: { imagesEdits: {} } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.endpoints).toEqual({ imagesGenerations: {}, imagesEdits: {} });
  });

  test('endpoints is an empty list (no entry emitted) when no target is currently available', () => {
    const aliases = [aliasFixture({
      name: 'ghost',
      targets: [{ target_model_id: 'missing', rules: {} }],
    })];
    expect(synthesizeListedAliases({ aliases, gatewayAddressableModelIds: [], callerAddressableModelIds: [], narrowTargets: false })).toEqual([]);
  });

  test('an alias target reachable only via the addressable-but-not-listed surface counts as available', () => {
    // A Copilot variant id like `claude-opus-4.7-high` collapses to the
    // canonical public id `claude-opus-4-7` at the resolver layer. The
    // listing now reads from the same addressable surface, so an alias
    // that targets the variant id resolves to the canonical model and the
    // synthesized entry inherits its catalog metadata.
    const canonical = realModel({
      id: 'claude-opus-4-7',
      display_name: 'Claude Opus 4.7',
      chat: { modalities: { input: ['text', 'image'], output: ['text'] } },
    });
    const aliases = [aliasFixture({
      name: 'fast-claude',
      targets: [{ target_model_id: 'claude-opus-4.7-high', rules: {} }],
    })];
    const addressableModelIds = [
      ...listed([canonical]),
      unlisted('claude-opus-4.7-high', canonical),
    ];
    const [entry] = synthesizeListedAliases({
      aliases,
      gatewayAddressableModelIds: addressableModelIds,
      callerAddressableModelIds: addressableModelIds,
      narrowTargets: false,
    });
    expect(entry.id).toBe('fast-claude');
    expect(entry.chat?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(entry.endpoints).toEqual({ chatCompletions: {}, messages: {}, responses: {} });
  });

  test('metadata is computed gateway-wide — same numbers regardless of caller cap', () => {
    // The alias has two targets with different windows. Two callers see
    // the alias: one with full gateway access, one capped to a subset.
    // Both must read the same `limits.max_context_window_tokens` because
    // the announced metadata is a stable property of the alias.
    const aliases = [aliasFixture({
      name: 'mix',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const a = realModel({ id: 'a', limits: { max_context_window_tokens: 100_000 } });
    const b = realModel({ id: 'b', limits: { max_context_window_tokens: 200_000 } });
    const gatewayWide = listed([a, b]);
    const restricted = listed([b]);

    const [unrestricted] = synthesizeListedAliases({
      aliases,
      gatewayAddressableModelIds: gatewayWide,
      callerAddressableModelIds: gatewayWide,
      narrowTargets: false,
    });
    const [scoped] = synthesizeListedAliases({
      aliases,
      gatewayAddressableModelIds: gatewayWide,
      callerAddressableModelIds: restricted,
      narrowTargets: true,
    });

    // Both callers read the safe-lower-bound min(100k, 200k) = 100k —
    // even though the scoped caller's resolver would never pick `a`.
    expect(unrestricted.limits.max_context_window_tokens).toBe(100_000);
    expect(scoped.limits.max_context_window_tokens).toBe(100_000);
    // Endpoints union also computed gateway-wide.
    expect(unrestricted.endpoints).toEqual(scoped.endpoints);
  });

  test('narrowTargets=true filters `aliasedFrom.targets` to caller-reachable; narrowTargets=false keeps raw config (typos included)', () => {
    const aliases = [aliasFixture({
      name: 'mix',
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
        { target_model_id: 'typo-no-such-model', rules: {} },
      ],
    })];
    const a = realModel({ id: 'a' });
    const b = realModel({ id: 'b' });
    const gatewayWide = listed([a, b]);
    const restricted = listed([b]);

    const [adminView] = synthesizeListedAliases({
      aliases,
      gatewayAddressableModelIds: gatewayWide,
      callerAddressableModelIds: gatewayWide,
      narrowTargets: false,
    });
    // Admin (narrowTargets=false) keeps the raw configured list,
    // including the typo, so the alias-edit dialog can render the full
    // configuration even when some targets do not currently resolve.
    expect(adminView.aliasedFrom?.targets.map(t => t.target_model_id)).toEqual(['a', 'b', 'typo-no-such-model']);

    const [scopedView] = synthesizeListedAliases({
      aliases,
      gatewayAddressableModelIds: gatewayWide,
      callerAddressableModelIds: restricted,
      narrowTargets: true,
    });
    // Non-admin / data-plane caller (narrowTargets=true) only sees the
    // targets sitting inside their addressable cap. Out-of-cap target
    // `a` AND the typo `typo-no-such-model` both drop out — the caller
    // never learns the operator's full alias configuration.
    expect(scopedView.aliasedFrom?.targets.map(t => t.target_model_id)).toEqual(['b']);
  });

  test('alias is omitted when caller cannot reach any of the configured targets', () => {
    const aliases = [aliasFixture({
      name: 'mix',
      targets: [{ target_model_id: 'a', rules: {} }],
    })];
    const a = realModel({ id: 'a' });
    expect(synthesizeListedAliases({
      aliases,
      gatewayAddressableModelIds: listed([a]),
      callerAddressableModelIds: [],  // caller sees nothing
      narrowTargets: true,
    })).toEqual([]);
  });
});
