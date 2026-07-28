import { describe, expect, it } from 'vitest';

import type { ControlPlaneModel } from '../../../src/api/types';
import { effectiveUpstreams, modelBadges } from '../../../src/components/models/model-badges';

const model = (id: string, upstreams: string[], extra: Partial<ControlPlaneModel> = {}): ControlPlaneModel => ({
  id, object: 'model', type: 'model', display_name: id, kind: 'chat', limits: {},
  endpoints: { chatCompletions: {} },
  upstreams: upstreams.map(upstream => ({ id: upstream, name: upstream, kind: 'custom', color: null })),
  ...extra,
});

describe('model badges', () => {
  it('abbreviates the token limits the catalog advertises', () => {
    expect(modelBadges(model('m', ['a'], {
      limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 1_500, max_output_tokens: 64_000 },
    }), [], null)).toEqual([
      { key: 'limit:context', kind: 'limit', limit: 'context', value: '1M' },
      { key: 'limit:prompt', kind: 'limit', limit: 'prompt', value: '1.5k' },
      { key: 'limit:output', kind: 'limit', limit: 'output', value: '64k' },
    ]);
    expect(modelBadges(model('m', ['a']), [], null)).toEqual([]);
  });

  it('names the sole reachable target and drops the selection strategy with it', () => {
    const real = model('real', ['a']);
    const capped = model('capped', ['b']);
    const alias = model('alias', [], {
      aliasedFrom: {
        selection: 'random',
        targets: [{ target_model_id: 'real', rules: {} }, { target_model_id: 'capped', rules: {} }],
      },
    });
    expect(modelBadges(alias, [real, capped, alias], ['a'])).toEqual([
      { key: 'aliasOf', kind: 'aliasOfModel', target: 'real' },
    ]);
    expect(modelBadges(alias, [real, capped, alias], null)).toEqual([
      { key: 'aliasOf', kind: 'aliasOfCount', reachable: 2, total: 2 },
      { key: 'selection', kind: 'selection', selection: 'random' },
    ]);
  });

  it('counts a target the catalog cannot resolve as out of reach', () => {
    const real = model('real', ['a']);
    const alias = model('alias', [], {
      aliasedFrom: {
        selection: 'first-available',
        targets: [{ target_model_id: 'real', rules: {} }, { target_model_id: 'withdrawn', rules: {} }],
      },
    });
    expect(modelBadges(alias, [real, alias], null)).toContainEqual(
      { key: 'aliasOf', kind: 'aliasOfModel', target: 'real' },
    );
    const unreachable = model('unreachable', [], {
      aliasedFrom: {
        selection: 'random',
        targets: [{ target_model_id: 'withdrawn', rules: {} }],
      },
    });
    expect(modelBadges(unreachable, [unreachable], null)).toEqual([
      { key: 'aliasOf', kind: 'aliasOfCount', reachable: 0, total: 1 },
    ]);
  });

  it('collapses a rule its targets disagree on', () => {
    const alias = (targets: { target_model_id: string; rules: Record<string, unknown> }[]) => model('alias', [], {
      aliasedFrom: { selection: 'random', targets },
    } as Partial<ControlPlaneModel>);
    const one = alias([{ target_model_id: 'a', rules: { reasoning: { effort: 'high' } } }]);
    expect(modelBadges(one, [model('a', ['u']), one], null)).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: 'high', varies: false },
    );
    const many = alias([
      { target_model_id: 'a', rules: { reasoning: { effort: 'high' } } },
      { target_model_id: 'b', rules: { reasoning: { effort: 'low' } } },
    ]);
    expect(modelBadges(many, [model('a', ['u']), model('b', ['u']), many], null)).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: null, varies: true },
    );
    const partlyUnset = alias([
      { target_model_id: 'a', rules: { reasoning: { effort: 'high' } } },
      { target_model_id: 'b', rules: {} },
    ]);
    expect(modelBadges(partlyUnset, [model('a', ['u']), model('b', ['u']), partlyUnset], null)).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: null, varies: true },
    );
    const capped = alias([
      { target_model_id: 'a', rules: { reasoning: { effort: 'high' } } },
      { target_model_id: 'b', rules: { reasoning: { effort: 'low' } } },
    ]);
    expect(modelBadges(capped, [model('a', ['u-a']), model('b', ['u-b']), capped], ['u-a'])).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: 'high', varies: false },
    );
    const disjoint = alias([
      { target_model_id: 'a', rules: { serviceTier: 'fast' } },
      { target_model_id: 'b', rules: { reasoning: { effort: 'high' } } },
    ]);
    expect(modelBadges(disjoint, [model('a', ['u']), model('b', ['u']), disjoint], null)
      .filter(badge => badge.kind === 'rule').map(badge => badge.field))
      .toEqual(['reasoning.effort', 'serviceTier']);
  });

  it('lifts an alias row onto the in-cap bindings of its reachable targets', () => {
    const real = model('real', ['a', 'b']);
    const other = model('other', ['b']);
    const alias = model('alias', [], {
      aliasedFrom: {
        selection: 'random',
        targets: [{ target_model_id: 'real', rules: {} }, { target_model_id: 'other', rules: {} }],
      },
    });
    const catalog = [real, other, alias];
    expect(effectiveUpstreams(alias, catalog, null).map(upstream => upstream.id)).toEqual(['a', 'b']);
    expect(effectiveUpstreams(alias, catalog, ['b']).map(upstream => upstream.id)).toEqual(['b']);
    expect(effectiveUpstreams(real, catalog, ['b']).map(upstream => upstream.id)).toEqual(['b']);
  });
});
