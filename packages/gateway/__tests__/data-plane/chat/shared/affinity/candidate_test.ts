import { describe, expect, test } from 'vitest';

import {
  type AffinityRequestAnalysis,
  type AffinityIdentity,
  candidateSatisfiesAffinityIdentity,
  type DecodedAffinityBlob,
  defineAffinityRequest,
  projectOptionalAffinityBlob,
  projectRequiredAffinityBlob,
  selectAffinityCandidates,
} from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

const candidate = (upstreamId: string, model: string, rules?: AliasRules) => {
  const base = stubModelCandidate();
  const value = stubModelCandidate({
    provider: { ...base.provider, upstreamId },
    model: { id: model },
  });
  return rules === undefined ? value : { ...value, rules };
};

const candidateWithScope = (
  upstreamId: string,
  model: string,
  scope: { bindToUpstream: boolean; key?: string },
) => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstreamId },
    model: {
      id: model,
      opaqueBlobCompatibilityScope: scope,
      providerModels: {
        [upstreamId]: stubProviderModel({ id: model, upstreamModelId: model, opaqueBlobCompatibilityScope: scope }),
      },
    },
  });
};

const targetFor = (value: ReturnType<typeof candidate>): AffinityIdentity => ({
  upstreamId: value.provider.upstreamId,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.provider.upstreamId, key: value.model.id },
});

const ownedBlob = (
  target: AffinityIdentity,
  value?: string,
): DecodedAffinityBlob => {
  const { opaqueBlobCompatibilityIdentity, ...affinity } = target;
  return {
    kind: 'owned',
    version: 2,
    affinity,
    opaqueBlobCompatibilityIdentity,
    ...(value !== undefined ? { value, origin: 'raw' as const } : {}),
  };
};

const affinity = (
  requiredTargets: readonly AffinityIdentity[] = [],
  degrading: readonly ModelCandidate[] = [],
): AffinityRequestAnalysis<undefined> => defineAffinityRequest(requiredTargets, candidate => {
  const unsatisfiedTargets = requiredTargets.filter(target => !candidateSatisfiesAffinityIdentity(candidate, target));
  return unsatisfiedTargets.length > 0
    ? { kind: 'rejected' }
    : { kind: 'accepted', degrades: degrading.includes(candidate), materialize: () => undefined };
});

const selectedCandidates = (
  candidates: readonly ModelCandidate[],
  analysis: AffinityRequestAnalysis<undefined>,
): readonly ModelCandidate[] => {
  const selection = selectAffinityCandidates(candidates, analysis);
  if ('kind' in selection) throw new Error(`Expected affinity selection, received ${selection.kind}`);
  return selection.candidates;
};

describe('client-carried affinity candidate selection', () => {
  test('keeps non-degrading candidates in resolver order before degrading fallbacks', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const third = candidate('up-c', 'model');

    expect(selectedCandidates(
      [first, second, third],
      affinity([], [first, third]),
    )).toEqual([second, first, third]);
  });

  test('keeps resolver order when every candidate preserves blobs or every candidate degrades', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');

    expect(selectedCandidates([first, second], affinity())).toEqual([first, second]);
    expect(selectedCandidates([first, second], affinity([], [first, second]))).toEqual([first, second]);
  });

  test('evaluates requirement eligibility and degradation before materializing selected payloads', () => {
    const required = candidate('up-a', 'model');
    const sameTargetAlias = candidate('up-a', 'model', { reasoning: { effort: 'low' } });
    const rejected = candidate('up-b', 'model');
    const evaluations: ModelCandidate[] = [];
    let materializations = 0;
    const analysis = defineAffinityRequest([targetFor(required)], value => {
      evaluations.push(value);
      if (!candidateSatisfiesAffinityIdentity(value, targetFor(required))) {
        return { kind: 'rejected' };
      }
      return {
        kind: 'accepted',
        degrades: value === required,
        materialize: () => {
          materializations += 1;
          return value.model.id;
        },
      };
    });

    const selection = selectAffinityCandidates([required, sameTargetAlias, rejected], analysis);
    if ('kind' in selection) throw new Error(`Expected affinity selection, received ${selection.kind}`);
    expect(selection.candidates).toEqual([sameTargetAlias, required]);
    expect(evaluations).toEqual([required, sameTargetAlias, rejected]);
    expect(materializations).toBe(0);
    expect(selection.payloadFor(sameTargetAlias)).toBe('model');
    expect(selection.payloadFor(sameTargetAlias)).toBe('model');
    expect(materializations).toBe(1);
    expect(() => selection.payloadFor(rejected)).toThrow('outside the selected set');
  });

  test('required state matches upstream and model while degradation orders rule variants', () => {
    const direct = candidate('up-a', 'model');
    const alias = candidate('up-a', 'model', { reasoning: { effort: 'low' } });
    const other = candidate('up-b', 'model');

    expect(selectedCandidates(
      [direct, alias, other],
      affinity([targetFor(alias)]),
    )).toEqual([direct, alias]);
    expect(selectedCandidates(
      [direct, alias, other],
      affinity([targetFor(alias)], [direct]),
    )).toEqual([alias, direct]);
  });

  test('fails unavailable and conflicting required affinity', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');

    expect(selectAffinityCandidates([first], affinity([targetFor(second)]))).toMatchObject({ kind: 'routing-unavailable' });
    expect(selectAffinityCandidates(
      [first, second],
      affinity([targetFor(first), targetFor(second)]),
    )).toMatchObject({ kind: 'routing-unavailable' });
  });

  test('rejects request analyses whose requirement inventory and candidate evaluation drift apart', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const acceptsUnsatisfied = defineAffinityRequest([targetFor(first)], () => ({
      kind: 'accepted',
      degrades: false,
      materialize: () => undefined,
    }));
    const rejectsSatisfied = defineAffinityRequest([], () => ({ kind: 'rejected' }));

    expect(() => acceptsUnsatisfied.evaluateCandidate(second)).toThrow('disagrees with the request requirement analysis');
    expect(() => rejectsSatisfied.evaluateCandidate(first)).toThrow('disagrees with the request requirement analysis');
  });
});

describe('affinity blob projection', () => {
  const exact = candidate('up-a', 'model', { reasoning: { effort: 'high' } });
  const samePhysicalTarget = candidate('up-a', 'model', { reasoning: { effort: 'low' } });
  const other = candidate('up-b', 'model');

  test('preserves foreign blobs independently of candidate and policy', () => {
    const foreign = { kind: 'foreign', value: 'opaque' } as const;
    expect(projectOptionalAffinityBlob(foreign, other)).toEqual({ kind: 'preserve', value: 'opaque', preferred: true });
    expect(projectRequiredAffinityBlob(foreign, other)).toEqual({ kind: 'preserve', value: 'opaque', preferred: true });
  });

  test('removes originless metadata without degradation', () => {
    const originless = ownedBlob(targetFor(exact));
    expect(projectOptionalAffinityBlob(originless, exact)).toEqual({ kind: 'remove', degrades: false, preferred: true });
    expect(projectOptionalAffinityBlob(originless, other)).toEqual({ kind: 'remove', degrades: false, preferred: true });
    expect(projectRequiredAffinityBlob(originless, samePhysicalTarget)).toEqual({ kind: 'remove', degrades: false, preferred: true });
  });

  test('preserves optional natural state across rule variants in the same compatibility identity', () => {
    const natural = ownedBlob(targetFor(exact), 'opaque');
    expect(projectOptionalAffinityBlob(natural, exact)).toEqual({ kind: 'preserve', value: 'opaque', preferred: true });
    expect(projectOptionalAffinityBlob(natural, samePhysicalTarget)).toEqual({ kind: 'preserve', value: 'opaque', preferred: false });
  });

  test('rejects required state outside its compatibility identity while accepting every rule variant', () => {
    const natural = ownedBlob(targetFor(exact), 'opaque');
    expect(projectRequiredAffinityBlob(natural, samePhysicalTarget)).toEqual({ kind: 'preserve', value: 'opaque', preferred: true });
    expect(projectRequiredAffinityBlob(natural, other)).toEqual({ kind: 'reject', requiredTarget: targetFor(exact) });
  });

  test('preserves blobs across models that share an upstream-bound compatibility identity', () => {
    const source = candidateWithScope('up-a', 'model-a', { bindToUpstream: true, key: 'openai' });
    const compatible = candidateWithScope('up-a', 'model-b', { bindToUpstream: true, key: 'openai' });
    const otherUpstream = candidateWithScope('up-b', 'model-b', { bindToUpstream: true, key: 'openai' });
    const natural = ownedBlob({
      ...targetFor(source),
      opaqueBlobCompatibilityIdentity: { upstreamId: 'up-a', key: 'openai' },
    }, 'opaque');

    expect(projectOptionalAffinityBlob(natural, compatible)).toEqual({ kind: 'preserve', value: 'opaque', preferred: false });
    expect(projectRequiredAffinityBlob(natural, compatible)).toEqual({ kind: 'preserve', value: 'opaque', preferred: false });
    expect(projectRequiredAffinityBlob(natural, otherUpstream)).toMatchObject({ kind: 'reject' });
  });

  test('preserves blobs across upstreams that share an unbound compatibility identity', () => {
    const source = candidateWithScope('up-a', 'model-a', { bindToUpstream: false, key: 'claude-opus' });
    const compatible = candidateWithScope('up-b', 'model-b', { bindToUpstream: false, key: 'claude-opus' });
    const natural = ownedBlob({
      ...targetFor(source),
      opaqueBlobCompatibilityIdentity: { key: 'claude-opus' },
    }, 'opaque');

    expect(projectRequiredAffinityBlob(natural, compatible)).toEqual({ kind: 'preserve', value: 'opaque', preferred: false });
  });
});
