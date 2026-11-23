import { describe, expect, test } from 'vitest';

import {
  type AffinityIdentity,
  affinityIdentityForCandidate,
  candidateSatisfiesAffinityIdentity,
  type DecodedAffinityBlob,
  projectOptionalAffinityBlob,
  projectRequiredAffinityBlob,
  type ScoreAffinity,
  uniqueRequiredAffinityTargets,
} from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { selectChatCandidates } from '../../../../../src/data-plane/chat/shared/affinity/stages.ts';
import { openaiChatCompletionsTarget } from '../../../../../src/data-plane/chat/shared/target-picker.ts';
import type { RouteCandidate } from '../../../../../src/data-plane/pipeline/services.ts';
import { chatUpstream } from '../fixture.ts';
import type { AliasRules } from '@floway-dev/protocols/common';

const candidate = (upstreamId: string, modelId: string, rules?: AliasRules) =>
  chatUpstream({ upstreamId, modelId, rules, endpoints: { openaiChatCompletions: {} } }).candidate;

const candidateWithScope = (
  upstreamId: string,
  model: string,
  scope: { bindToUpstream: boolean; key?: string },
) => {
  const base = candidate(upstreamId, model);
  return { ...base, providerModel: { ...base.providerModel, opaqueBlobCompatibilityScope: scope } };
};

const targetFor = affinityIdentityForCandidate;

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
  degrading: readonly RouteCandidate[] = [],
) => ({ requiredTargets: uniqueRequiredAffinityTargets(requiredTargets), degrading });

const score: ScoreAffinity<ReturnType<typeof affinity>, undefined> = ({ requiredTargets, degrading }, candidate) =>
  requiredTargets.every(target => candidateSatisfiesAffinityIdentity(candidate, target))
    ? { kind: 'accepted', degrades: degrading.includes(candidate) }
    : { kind: 'rejected' };

const select = (candidates: readonly RouteCandidate[], analysis: ReturnType<typeof affinity>) =>
  selectChatCandidates(candidates, openaiChatCompletionsTarget, analysis, undefined, score, 'model');

describe('client-carried affinity candidate selection', () => {
  test('required state matches upstream and model while degradation orders rule variants', () => {
    const direct = candidate('up-a', 'model');
    const alias = candidate('up-a', 'model', { reasoning: { effort: 'low' } });
    const other = candidate('up-b', 'model');

    expect(select(
      [direct, alias, other],
      affinity([targetFor(alias)]),
    )).toEqual([direct, alias]);
    expect(select(
      [direct, alias, other],
      affinity([targetFor(alias)], [direct]),
    )).toEqual([alias, direct]);
  });

  test('fails unavailable and conflicting required affinity', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');

    expect(select([first], affinity([targetFor(second)]))).toMatchObject({ kind: 'routing-unavailable' });
    expect(select(
      [first, second],
      affinity([targetFor(first), targetFor(second)]),
    )).toMatchObject({ kind: 'routing-unavailable' });
  });
});

describe('affinity blob projection', () => {
  const exact = candidate('up-a', 'model', { reasoning: { effort: 'high' } });
  const samePhysicalTarget = candidate('up-a', 'model', { reasoning: { effort: 'low' } });
  const other = candidate('up-b', 'model');

  test('removes originless metadata without degradation', () => {
    const originless = ownedBlob(targetFor(exact));
    expect(projectOptionalAffinityBlob(originless, exact)).toEqual({ kind: 'remove', incompatible: false, degrades: false, preferred: true });
    expect(projectOptionalAffinityBlob(originless, other)).toEqual({ kind: 'remove', incompatible: true, degrades: false, preferred: true });
    expect(projectRequiredAffinityBlob(originless, samePhysicalTarget)).toEqual({ kind: 'remove', incompatible: false, degrades: false, preferred: true });
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
});
