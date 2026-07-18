import { describe, expect, test } from 'vitest';

import { routeCandidatesByAffinity } from './index.ts';
import type { AffinityEvidence, AffinityTarget } from './index.ts';
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

const targetFor = (value: ReturnType<typeof candidate>): AffinityTarget => ({
  upstreamId: value.provider.upstream,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
});

const evidence = (value: ReturnType<typeof candidate>, mode: AffinityEvidence['mode'] = 'prefer'): AffinityEvidence => ({
  target: targetFor(value),
  mode,
});

describe('client-carried affinity candidate routing', () => {
  test('treats empty alias rules as the direct no-overlay variant', () => {
    const direct = candidate('up-a', 'model-a');
    const alias = candidate('up-a', 'model-a', {});
    const overridden = candidate('up-a', 'model-a', { reasoning: { effort: 'low' } });

    expect(routeCandidatesByAffinity([alias, direct, overridden], [evidence(direct)])).toEqual({
      kind: 'success',
      candidates: [alias, direct, overridden],
    });
    expect(routeCandidatesByAffinity([direct, alias, overridden], [evidence(overridden)])).toEqual({
      kind: 'success',
      candidates: [overridden, direct, alias],
    });
  });

  test('moves the latest available preferred target to the front', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const decision = routeCandidatesByAffinity(
      [first, second],
      [evidence(first), evidence(second)],
    );

    expect(decision.kind).toBe('success');
    if (decision.kind !== 'success') throw new Error('Expected successful routing');
    expect(decision.candidates).toEqual([second, first]);
  });

  test('keeps normal order when a preferred target is unavailable', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const unavailable = candidate('up-c', 'model');

    expect(routeCandidatesByAffinity([first, second], [evidence(unavailable)])).toEqual({
      kind: 'success',
      candidates: [first, second],
    });
  });

  test('uses the latest preferred target that remains available', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const unavailable = candidate('up-c', 'model');

    expect(routeCandidatesByAffinity([second, first], [evidence(first), evidence(unavailable)])).toEqual({
      kind: 'success',
      candidates: [first, second],
    });
  });

  test('force matches upstream and model without narrowing alias rules', () => {
    const direct = candidate('up-a', 'model');
    const alias = candidate('up-a', 'model', {});

    expect(routeCandidatesByAffinity([direct, alias], [evidence(alias, 'force')])).toEqual({
      kind: 'success',
      candidates: [direct, alias],
    });
  });

  test('exact preference still orders rule variants inside a shared force target', () => {
    const direct = candidate('up-a', 'model');
    const alias = candidate('up-a', 'model', { reasoning: { effort: 'low' } });

    expect(routeCandidatesByAffinity(
      [direct, alias],
      [evidence(direct, 'force'), evidence(alias, 'force'), evidence(alias)],
    )).toEqual({
      kind: 'success',
      candidates: [alias, direct],
    });
  });

  test('fails unavailable and conflicting force affinity', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');

    expect(routeCandidatesByAffinity([first], [evidence(second, 'force')])).toMatchObject({ kind: 'failure' });
    expect(routeCandidatesByAffinity([first, second], [
      evidence(first, 'force'),
      evidence(second, 'force'),
    ])).toMatchObject({ kind: 'failure' });
  });
});
