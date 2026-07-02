import { describe, expect, it } from 'vitest';

import { effectiveUpstreamCap, isReachableUnderCap, reachableTargets } from './reachability.ts';
import { buildAliasModel, buildRealModel, buildUnlistedModel } from '../api/test-fixtures.ts';
import type { ControlPlaneModel } from '../api/types.ts';

const realWithUpstreams = (id: string, upstreams: { id: string }[]): ControlPlaneModel => buildRealModel({
  id,
  upstreams: upstreams.map(u => ({ id: u.id, name: u.id.toUpperCase(), kind: 'custom' })),
});

const aliasWithTargets = (id: string, targetIds: string[]): ControlPlaneModel => buildAliasModel({
  id,
  aliasedFrom: {
    selection: 'first-available',
    targets: targetIds.map(tid => ({ target_model_id: tid, rules: {} })),
  },
});

describe('effectiveUpstreamCap', () => {
  it('intersects when both caps are set — key ⊆ user (creation-time invariant)', () => {
    expect(effectiveUpstreamCap(['up_a'], ['up_a', 'up_b'])).toEqual(['up_a']);
  });

  it('intersects when the user cap has been narrowed post-key-creation', () => {
    // API-keys route enforces key ⊆ user at creation, but the user cap can
    // shrink later without touching the key row. The frontend must not
    // surface upstreams the backend would silently reject at dispatch.
    expect(effectiveUpstreamCap(['up_a', 'up_b'], ['up_a'])).toEqual(['up_a']);
  });

  it('collapses to [] when the two caps are disjoint', () => {
    expect(effectiveUpstreamCap(['up_a'], ['up_b'])).toEqual([]);
  });

  it('falls back to the user cap when the key has no whitelist', () => {
    expect(effectiveUpstreamCap(null, ['up_a', 'up_b'])).toEqual(['up_a', 'up_b']);
  });

  it('falls back to the key cap when the user has no whitelist', () => {
    expect(effectiveUpstreamCap(['up_a'], null)).toEqual(['up_a']);
  });

  it('returns null (unrestricted) when both are null', () => {
    expect(effectiveUpstreamCap(null, null)).toBeNull();
  });
});

describe('isReachableUnderCap — real models', () => {
  const a = realWithUpstreams('a', [{ id: 'up_1' }]);

  it('returns true when the cap is null', () => {
    expect(isReachableUnderCap(a, [a], null)).toBe(true);
  });

  it('returns true when any binding is in the cap', () => {
    expect(isReachableUnderCap(a, [a], ['up_1', 'up_2'])).toBe(true);
  });

  it('returns false when no binding is in the cap', () => {
    expect(isReachableUnderCap(a, [a], ['up_2'])).toBe(false);
  });
});

describe('isReachableUnderCap — aliases', () => {
  it('returns true when at least one target is reachable', () => {
    const target = realWithUpstreams('gpt-5', [{ id: 'up_1' }]);
    const otherTarget = realWithUpstreams('claude', [{ id: 'up_2' }]);
    const alias = aliasWithTargets('smart', ['gpt-5', 'claude']);
    const catalog = [target, otherTarget, alias];
    expect(isReachableUnderCap(alias, catalog, ['up_1'])).toBe(true);
  });

  it('returns false when every target is out of cap', () => {
    const target = realWithUpstreams('gpt-5', [{ id: 'up_1' }]);
    const alias = aliasWithTargets('smart', ['gpt-5']);
    expect(isReachableUnderCap(alias, [target, alias], ['up_2'])).toBe(false);
  });

  it('returns false when the alias has no targets at all', () => {
    const alias = aliasWithTargets('orphan', []);
    expect(isReachableUnderCap(alias, [alias], ['up_1'])).toBe(false);
  });

  it('drops a target whose id resolves to no real-model row in the catalog', () => {
    // Operator typo or removed model — the resolver would 404 at request
    // time, the frontend filter treats the same way.
    const alias = aliasWithTargets('smart', ['missing']);
    expect(isReachableUnderCap(alias, [alias], null)).toBe(false);
  });
});

describe('reachableTargets', () => {
  it('returns every target whose real-model row is in cap', () => {
    const gpt = realWithUpstreams('gpt-5', [{ id: 'up_1' }]);
    const claude = realWithUpstreams('claude', [{ id: 'up_2' }]);
    const alias = aliasWithTargets('smart', ['gpt-5', 'claude']);
    const reachable = reachableTargets(alias, [gpt, claude, alias], ['up_1']);
    expect(reachable.map(m => m.id)).toEqual(['gpt-5']);
  });

  it('matches addressable-but-not-listed entries against the real-model surface', () => {
    // `buildUnlistedModel` carries `aliasedFrom === undefined` (it represents
    // a real model's variant id), so the alias's target_model_id pointing
    // at the variant id still matches the real-model lookup.
    const opus = buildUnlistedModel({
      id: 'claude-opus-4.7',
      upstreams: [{ id: 'up_1', name: 'UP1', kind: 'copilot' }],
    });
    const alias = aliasWithTargets('opus-fast', ['claude-opus-4.7']);
    const reachable = reachableTargets(alias, [opus, alias], ['up_1']);
    expect(reachable.map(m => m.id)).toEqual(['claude-opus-4.7']);
  });

  it('returns empty for a non-alias row', () => {
    const a = realWithUpstreams('a', [{ id: 'up_1' }]);
    expect(reachableTargets(a, [a], null)).toEqual([]);
  });
});
