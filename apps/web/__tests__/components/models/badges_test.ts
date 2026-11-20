import { describe, expect, it } from 'vitest';

import { modelBadges } from '../../../src/components/models/badges';
import { indexCatalog } from '../../../src/components/models/catalog-index';
import { catalogModel } from '../../api/model-fixture';
import type { AliasTarget } from '@floway-dev/protocols/browser';

describe('model badges', () => {
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
});
