import { describe, expect, test } from 'vitest';

import { affinityTargetForCandidate, candidateMatchesAffinity, routeCandidatesByAffinity } from './candidate.ts';
import type { AliasRules } from '@floway-dev/protocols/common';
import { stubModelCandidate } from '@floway-dev/test-utils';

const candidate = (upstream: string, model: string, rules?: AliasRules) => {
  const base = stubModelCandidate();
  const value = stubModelCandidate({
    provider: { ...base.provider, upstream },
    model: { id: model },
  });
  return rules === undefined ? value : { ...value, rules };
};

describe('client-carried affinity candidate routing', () => {
  test('matches upstream, model, and the exact alias rules presence', () => {
    const direct = candidate('up-a', 'model-a');
    const alias = candidate('up-a', 'model-a', {});

    expect(candidateMatchesAffinity(direct, affinityTargetForCandidate(direct))).toBe(true);
    expect(candidateMatchesAffinity(alias, affinityTargetForCandidate(direct))).toBe(false);
    expect(candidateMatchesAffinity(candidate('up-a', 'model-b'), affinityTargetForCandidate(direct))).toBe(false);
  });

  test('moves the latest available preferred target to the front', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const decision = routeCandidatesByAffinity(
      [first, second],
      [affinityTargetForCandidate(first), affinityTargetForCandidate(second)],
    );

    expect(decision.kind).toBe('success');
    if (decision.kind !== 'success') throw new Error('Expected successful routing');
    expect(decision.candidates).toEqual([second, first]);
  });

  test('keeps normal order when a preferred target is unavailable', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const unavailable = candidate('up-c', 'model');

    expect(routeCandidatesByAffinity([first, second], [affinityTargetForCandidate(unavailable)])).toEqual({
      kind: 'success',
      candidates: [first, second],
    });
  });

  test('fails unavailable and conflicting force affinity', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');

    expect(routeCandidatesByAffinity([first], [{ ...affinityTargetForCandidate(second), mode: 'force' }])).toMatchObject({ kind: 'failure' });
    expect(routeCandidatesByAffinity([first, second], [
      { ...affinityTargetForCandidate(first), mode: 'force' },
      { ...affinityTargetForCandidate(second), mode: 'force' },
    ])).toMatchObject({ kind: 'failure' });
  });
});
