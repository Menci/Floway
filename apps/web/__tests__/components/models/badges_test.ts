import { describe, expect, it } from 'vitest';

import { effectiveUpstreams, modelBadges } from '../../../src/components/models/badges';
import { indexCatalog } from '../../../src/components/models/catalog-index';
import { catalogModel } from '../../api/model-fixture';
import type { AliasTarget } from '@floway-dev/protocols/common';

describe('model badges', () => {
  it('abbreviates the token limits the catalog advertises', () => {
    expect(modelBadges(catalogModel('m', {
      upstreams: ['a'],
      limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 1_500, max_output_tokens: 64_000 },
    }), indexCatalog([]), null)).toEqual([
      { key: 'limit:context', kind: 'limit', limit: 'context', value: '1M' },
      { key: 'limit:prompt', kind: 'limit', limit: 'prompt', value: '1.5k' },
      { key: 'limit:output', kind: 'limit', limit: 'output', value: '64k' },
    ]);
    expect(modelBadges(catalogModel('m', { upstreams: ['a'] }), indexCatalog([]), null)).toEqual([]);
  });

  it('names the sole reachable target and drops the selection strategy with it', () => {
    const real = catalogModel('real', { upstreams: ['a'] });
    const capped = catalogModel('capped', { upstreams: ['b'] });
    const alias = catalogModel('alias', {
      upstreams: [],
      aliasedFrom: {
        selection: 'random',
        targets: [{ target_model_id: 'real', rules: {} }, { target_model_id: 'capped', rules: {} }],
      },
    });
    expect(modelBadges(alias, indexCatalog([real, capped, alias]), ['a'])).toEqual([
      { key: 'aliasOf', kind: 'aliasOfModel', target: 'real' },
    ]);
    expect(modelBadges(alias, indexCatalog([real, capped, alias]), null)).toEqual([
      { key: 'aliasOf', kind: 'aliasOfCount', reachable: 2, total: 2 },
      { key: 'selection', kind: 'selection', selection: 'random' },
    ]);
  });

  it('counts a target the catalog cannot resolve as out of reach', () => {
    const real = catalogModel('real', { upstreams: ['a'] });
    const alias = catalogModel('alias', {
      upstreams: [],
      aliasedFrom: {
        selection: 'first-available',
        targets: [{ target_model_id: 'real', rules: {} }, { target_model_id: 'withdrawn', rules: {} }],
      },
    });
    expect(modelBadges(alias, indexCatalog([real, alias]), null)).toContainEqual(
      { key: 'aliasOf', kind: 'aliasOfModel', target: 'real' },
    );
    const unreachable = catalogModel('unreachable', {
      upstreams: [],
      aliasedFrom: {
        selection: 'random',
        targets: [{ target_model_id: 'withdrawn', rules: {} }],
      },
    });
    expect(modelBadges(unreachable, indexCatalog([unreachable]), null)).toEqual([
      { key: 'aliasOf', kind: 'aliasOfCount', reachable: 0, total: 1 },
    ]);
  });

  it('collapses a rule its targets disagree on', () => {
    const alias = (targets: AliasTarget[]) =>
      catalogModel('alias', { aliasedFrom: { selection: 'random', targets } });
    const one = alias([{ target_model_id: 'a', rules: { reasoning: { effort: 'high' } } }]);
    expect(modelBadges(one, indexCatalog([catalogModel('a', { upstreams: ['u'] }), one]), null)).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: 'high', varies: false },
    );
    const many = alias([
      { target_model_id: 'a', rules: { reasoning: { effort: 'high' } } },
      { target_model_id: 'b', rules: { reasoning: { effort: 'low' } } },
    ]);
    expect(modelBadges(many, indexCatalog([catalogModel('a', { upstreams: ['u'] }), catalogModel('b', { upstreams: ['u'] }), many]), null)).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: null, varies: true },
    );
    const partlyUnset = alias([
      { target_model_id: 'a', rules: { reasoning: { effort: 'high' } } },
      { target_model_id: 'b', rules: {} },
    ]);
    expect(modelBadges(partlyUnset, indexCatalog([catalogModel('a', { upstreams: ['u'] }), catalogModel('b', { upstreams: ['u'] }), partlyUnset]), null)).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: null, varies: true },
    );
    const capped = alias([
      { target_model_id: 'a', rules: { reasoning: { effort: 'high' } } },
      { target_model_id: 'b', rules: { reasoning: { effort: 'low' } } },
    ]);
    expect(modelBadges(capped, indexCatalog([catalogModel('a', { upstreams: ['u-a'] }), catalogModel('b', { upstreams: ['u-b'] }), capped]), ['u-a'])).toContainEqual(
      { key: 'rule:reasoning.effort', kind: 'rule', field: 'reasoning.effort', value: 'high', varies: false },
    );
    const disjoint = alias([
      { target_model_id: 'a', rules: { serviceTier: 'fast' } },
      { target_model_id: 'b', rules: { reasoning: { effort: 'high' } } },
    ]);
    expect(modelBadges(disjoint, indexCatalog([catalogModel('a', { upstreams: ['u'] }), catalogModel('b', { upstreams: ['u'] }), disjoint]), null)
      .filter(badge => badge.kind === 'rule').map(badge => badge.field))
      .toEqual(['reasoning.effort', 'serviceTier']);
  });

  it('lifts an alias row onto the in-cap bindings of its reachable targets', () => {
    const real = catalogModel('real', { upstreams: ['a', 'b'] });
    const other = catalogModel('other', { upstreams: ['b'] });
    const alias = catalogModel('alias', {
      upstreams: [],
      aliasedFrom: {
        selection: 'random',
        targets: [{ target_model_id: 'real', rules: {} }, { target_model_id: 'other', rules: {} }],
      },
    });
    const catalog = indexCatalog([real, other, alias]);
    expect(effectiveUpstreams(alias, catalog, null).map(upstream => upstream.id)).toEqual(['a', 'b']);
    expect(effectiveUpstreams(alias, catalog, ['b']).map(upstream => upstream.id)).toEqual(['b']);
    expect(effectiveUpstreams(real, catalog, ['b']).map(upstream => upstream.id)).toEqual(['b']);
  });
});
