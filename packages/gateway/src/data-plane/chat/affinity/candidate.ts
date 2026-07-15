import { isEqual } from 'es-toolkit';

import type { AffinityTarget } from './types.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { ModelCandidate } from '@floway-dev/provider';

const sameTarget = (left: AffinityTarget, right: AffinityTarget): boolean =>
  left.upstreamId === right.upstreamId
  && left.upstreamRevision === right.upstreamRevision
  && left.modelId === right.modelId
  && left.rulesPresent === right.rulesPresent
  && isEqual(left.rules, right.rules);

export const affinityTargetForCandidate = (candidate: ModelCandidate): AffinityTarget => ({
  mode: 'prefer',
  upstreamId: candidate.provider.upstream,
  upstreamRevision: candidate.provider.upstreamRevision,
  modelId: candidate.model.id,
  rulesPresent: candidate.rules !== undefined,
  ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
});

export const candidateMatchesAffinity = (candidate: ModelCandidate, affinity: AffinityTarget): boolean =>
  candidate.provider.upstream === affinity.upstreamId
  && candidate.provider.upstreamRevision === affinity.upstreamRevision
  && candidate.model.id === affinity.modelId
  && (candidate.rules !== undefined) === affinity.rulesPresent
  && isEqual(candidate.rules, affinity.rules);

export const routeCandidatesByAffinity = <T extends ModelCandidate>(
  candidates: readonly T[],
  affinities: readonly AffinityTarget[],
): RoutingDecision<T> => {
  const forcing: AffinityTarget[] = [];
  for (const affinity of affinities) {
    if (affinity.mode === 'force' && !forcing.some(existing => sameTarget(existing, affinity))) forcing.push(affinity);
  }
  if (forcing.length > 1) {
    return {
      kind: 'failure',
      failure: {
        kind: 'routing-unavailable',
        message: `Client-carried state requires multiple incompatible targets: ${forcing.map(target => `'${target.upstreamId}/${target.modelId}'`).join(', ')}.`,
      },
    };
  }
  if (forcing.length === 1) {
    const matching = candidates.filter(candidate => candidateMatchesAffinity(candidate, forcing[0]));
    return matching.length > 0
      ? { kind: 'success', candidates: matching }
      : {
          kind: 'failure',
          failure: {
            kind: 'routing-unavailable',
            message: `Client-carried state requires unavailable target '${forcing[0].upstreamId}/${forcing[0].modelId}'.`,
          },
        };
  }

  const preferred = affinities.findLast(affinity => affinity.mode === 'prefer');
  if (preferred === undefined) return { kind: 'success', candidates };
  const matching = candidates.filter(candidate => candidateMatchesAffinity(candidate, preferred));
  if (matching.length === 0) return { kind: 'success', candidates };
  return {
    kind: 'success',
    candidates: [
      ...matching,
      ...candidates.filter(candidate => !candidateMatchesAffinity(candidate, preferred)),
    ],
  };
};
