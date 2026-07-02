import { describe, expect, it } from 'vitest';

import { computeAliasLevelWarnings, computeModelWarnings, computeRuleWarnings, findCatalogModel, type AliasView } from './warnings.ts';
import { buildAliasModel as aliasModel, buildRealModel as realModel, buildUnlistedModel as unlistedModel } from '../../api/test-fixtures.ts';
import type { ControlPlaneModel } from '../../api/types.ts';

const view = (name: string, ids: readonly string[]): AliasView => ({
  name,
  targets: ids.map(id => ({ target_model_id: id })),
});

describe('findCatalogModel', () => {
  it('looks up the catalog row by id', () => {
    const catalog: ControlPlaneModel[] = [realModel({ id: 'gpt-5' }), realModel({ id: 'claude' })];
    expect(findCatalogModel(catalog, 'claude')?.id).toBe('claude');
    expect(findCatalogModel(catalog, 'unknown')).toBeUndefined();
  });

  it('skips alias rows that share an id with a target — they never re-enter the alias layer at runtime', () => {
    // Both rows share id 'auto-review' (the alias name shadowing nothing
    // real). findCatalogModel must not return the alias entry — its
    // capability metadata is the wrong source for a real-model rule
    // warning. computeModelWarnings should treat the id as unknown
    // instead.
    const catalog: ControlPlaneModel[] = [aliasModel({ id: 'auto-review' })];
    expect(findCatalogModel(catalog, 'auto-review')).toBeUndefined();
  });
});

describe('computeModelWarnings', () => {
  it('returns no warning when the target resolves to a same-kind catalog entry', () => {
    const catalog = realModel({ id: 'gpt-5', kind: 'chat' });
    expect(computeModelWarnings('gpt-5', catalog, 'chat')).toEqual([]);
  });

  it('returns a "does not resolve" warning when the target is unknown', () => {
    const w = computeModelWarnings('mystery-model', undefined, 'chat');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('mystery-model');
    expect(w[0]).toContain('does not currently resolve');
  });

  it('returns a kind-mismatch warning when the catalog row is the wrong kind', () => {
    const w = computeModelWarnings('text-emb-3', realModel({ id: 'text-emb-3', kind: 'embedding' }), 'chat');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('text-emb-3');
    expect(w[0]).toContain('embedding');
    expect(w[0]).toContain('chat');
  });

  it('emits no warning for an empty id (the row is mid-edit)', () => {
    expect(computeModelWarnings('', undefined, 'chat')).toEqual([]);
  });
});

describe('computeRuleWarnings', () => {
  const catalogWithReasoning = realModel({
    id: 'gpt-5',
    chat: {
      reasoning: {
        effort: { supported: ['low', 'medium'], default: 'medium' },
        budget_tokens: { min: 100, max: 1000 },
      },
    },
  });

  it('flags effort values not in the advertised supported list', () => {
    const w = computeRuleWarnings({ reasoning: { effort: 'xhigh' } }, catalogWithReasoning);
    expect(w).toHaveLength(1);
    expect(w[0].field).toBe('reasoning.effort');
    expect(w[0].message).toContain('low, medium');
  });

  it('does not flag effort values that are advertised', () => {
    const w = computeRuleWarnings({ reasoning: { effort: 'low' } }, catalogWithReasoning);
    expect(w).toEqual([]);
  });

  it('flags budgets outside the advertised range', () => {
    const tooHigh = computeRuleWarnings({ reasoning: { budget_tokens: 5000 } }, catalogWithReasoning);
    expect(tooHigh[0].field).toBe('reasoning.budget_tokens');
    expect(tooHigh[0].message).toContain('1000');
    const tooLow = computeRuleWarnings({ reasoning: { budget_tokens: 10 } }, catalogWithReasoning);
    expect(tooLow[0].field).toBe('reasoning.budget_tokens');
    expect(tooLow[0].message).toContain('100');
  });

  it('flags adaptive=true when the target does not advertise adaptive', () => {
    const w = computeRuleWarnings({ reasoning: { adaptive: true } }, catalogWithReasoning);
    expect(w).toHaveLength(1);
    expect(w[0].field).toBe('reasoning.adaptive');
  });

  it('flags reasoning at all when the target lacks reasoning metadata', () => {
    const noReasoning = realModel({ id: 'gpt-5', chat: {} });
    const w = computeRuleWarnings({ reasoning: { effort: 'low' } }, noReasoning);
    expect(w[0].field).toBe('reasoning.effort');
    expect(w[0].message).toContain('does not advertise');
  });
});

describe('computeAliasLevelWarnings', () => {
  const catalog: ControlPlaneModel[] = [
    realModel({ id: 'gpt-5', display_name: 'GPT 5' }),
    realModel({ id: 'plain' }),
    aliasModel({ id: 'auto-review' }),
  ];

  it('returns no warnings when the alias name is fresh and every target resolves', () => {
    expect(computeAliasLevelWarnings(view('fresh', ['gpt-5']), catalog)).toEqual([]);
  });

  it('emits a shadow warning when the alias name collides with a listed real id and no target references it', () => {
    const warnings = computeAliasLevelWarnings(view('gpt-5', ['plain']), catalog);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(expect.objectContaining({
      type: 'shadow',
      shadowedId: 'gpt-5',
      shadowedDisplayName: 'GPT 5',
    }));
  });

  it('suppresses the shadow warning when one of the targets references the shadowed id (seed pattern)', () => {
    expect(computeAliasLevelWarnings(view('gpt-5', ['gpt-5', 'plain']), catalog))
      .toEqual([]);
  });

  it('ignores collisions with addressable-but-not-listed variant ids (preserves today\'s scope)', () => {
    const withUnlisted: ControlPlaneModel[] = [
      ...catalog,
      unlistedModel({ id: 'claude-opus-4.7-high' }),
    ];
    expect(computeAliasLevelWarnings(view('claude-opus-4.7-high', ['gpt-5']), withUnlisted))
      .toEqual([]);
  });

  it('emits a no-target warning when every configured target falls outside the addressable surface', () => {
    const warnings = computeAliasLevelWarnings(view('lonely', ['missing-a', 'missing-b']), catalog);
    expect(warnings).toEqual([{
      type: 'no-target',
      message: 'No target resolves to any model on this gateway.',
    }]);
  });

  it('counts addressable-but-not-listed entries as available for the no-target check', () => {
    const withUnlisted: ControlPlaneModel[] = [
      ...catalog,
      unlistedModel({ id: 'claude-opus-4.7-high' }),
    ];
    expect(computeAliasLevelWarnings(view('fast-claude', ['claude-opus-4.7-high']), withUnlisted))
      .toEqual([]);
  });

  it('returns both warnings when an alias both shadows a listed id and has no reachable target', () => {
    // Real catalog deliberately drops the shadowed id so the no-target
    // branch also fires. (`gpt-5` shadowed, target `gpt-5` does not exist
    // here.)
    const warnings = computeAliasLevelWarnings(view('gpt-5', ['gone']), [realModel({ id: 'gpt-5' })]);
    expect(warnings.map(w => w.type).sort()).toEqual(['no-target', 'shadow']);
  });

  it('skips the no-target warning while the catalog is loading (models is null)', () => {
    expect(computeAliasLevelWarnings(view('lonely', ['missing']), null)).toEqual([]);
  });
});
