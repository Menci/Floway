import { describe, expect, test } from 'vitest';

import type { AddressableIdEntry } from '../../../../src/data-plane/shared/listing/addressable.ts';
import { synthesizeListedAliases } from '../../../../src/data-plane/shared/listing/alias.ts';
import type { ModelAliasRecord } from '../../../../src/repo/types.ts';
import type { InternalModel, ProviderModel } from '@floway-dev/provider';

const aliasFixture = (overrides: Partial<ModelAliasRecord> = {}): ModelAliasRecord => ({
  id: `alias_${overrides.name ?? 'gpt-fast'}`,
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
  endpoints: { openaiChatCompletions: {}, anthropicMessages: {}, openaiResponses: {} },
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
  test('publishes a common opaque-blob scope and falls back for mixed targets', () => {
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const common = { bindToUpstream: true, key: 'openai' } as const;
    const matching = [
      realModel({ id: 'a', opaqueBlobCompatibilityScope: common }),
      realModel({ id: 'b', opaqueBlobCompatibilityScope: common }),
    ];
    const [shared] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(matching), callerAddressableModelIds: listed(matching), narrowTargets: false });
    expect(shared.opaqueBlobCompatibilityScope).toEqual(common);

    const mixed = [matching[0], realModel({ id: 'b', opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'openai' } })];
    const [fallback] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(mixed), callerAddressableModelIds: listed(mixed), narrowTargets: false });
    expect(fallback.opaqueBlobCompatibilityScope).toEqual({ bindToUpstream: true });
  });

  test('a split verdict on detail original announces false rather than dropping the field', () => {
    // Conjunction, not agreement: the announced metadata must not promise detail
    // 'original' above any single target's own answer. Both targets declare the
    // field here, so the split yields a stated `false` — the field's own answer,
    // not a re-encoding of absence.
    const aliases = [aliasFixture({
      targets: [
        { target_model_id: 'a', rules: {} },
        { target_model_id: 'b', rules: {} },
      ],
    })];
    const realModels = [
      realModel({ id: 'a', chat: { image_detail_original: true } }),
      realModel({ id: 'b', chat: { image_detail_original: false } }),
    ];
    const [entry] = synthesizeListedAliases({ aliases, gatewayAddressableModelIds: listed(realModels), callerAddressableModelIds: listed(realModels), narrowTargets: false });
    expect(entry.chat?.image_detail_original).toBe(false);
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
    expect(entry.endpoints).toEqual({ openaiChatCompletions: {}, anthropicMessages: {}, openaiResponses: {} });
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
});
