import { describe, expect, test } from 'vitest';

import { narrowCandidatesByAffinity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { AffinityEvidence, AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { AliasRules } from '@floway-dev/protocols/common';
import { stubModelCandidate } from '@floway-dev/test-utils';

const candidate = (upstreamId: string, model: string, rules?: AliasRules) => {
  const base = stubModelCandidate();
  const value = stubModelCandidate({
    provider: { ...base.provider, upstreamId },
    model: { id: model },
  });
  return rules === undefined ? value : { ...value, rules };
};

const targetFor = (value: ReturnType<typeof candidate>): AffinityTarget => ({
  upstreamId: value.provider.upstreamId,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
});

const evidence = (value: ReturnType<typeof candidate>, mode: AffinityEvidence['mode'] = 'prefer'): AffinityEvidence => ({
  target: targetFor(value),
  mode,
});

describe('client-carried affinity candidate narrowing', () => {
  test('treats empty alias rules as the direct no-overlay variant', () => {
    const direct = candidate('up-a', 'model-a');
    const alias = candidate('up-a', 'model-a', {});
    const overridden = candidate('up-a', 'model-a', { reasoning: { effort: 'low' } });

    expect(narrowCandidatesByAffinity([alias, direct, overridden], [evidence(direct)])).toEqual([alias, direct, overridden]);
    expect(narrowCandidatesByAffinity([direct, alias, overridden], [evidence(overridden)])).toEqual([overridden, direct, alias]);
  });

  test('moves the latest available preferred target to the front', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');

    expect(narrowCandidatesByAffinity(
      [first, second],
      [evidence(first), evidence(second)],
    )).toEqual([second, first]);
  });

  test('keeps normal order when a preferred target is unavailable', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const unavailable = candidate('up-c', 'model');

    expect(narrowCandidatesByAffinity([first, second], [evidence(unavailable)])).toEqual([first, second]);
  });

  test('uses the latest preferred target that remains available', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');
    const unavailable = candidate('up-c', 'model');

    expect(narrowCandidatesByAffinity([second, first], [evidence(first), evidence(unavailable)])).toEqual([first, second]);
  });

  test('force matches upstream and model without narrowing alias rules', () => {
    const direct = candidate('up-a', 'model');
    const alias = candidate('up-a', 'model', {});

    expect(narrowCandidatesByAffinity([direct, alias], [evidence(alias, 'force')])).toEqual([direct, alias]);
  });

  test('exact preference still orders rule variants inside a shared force target', () => {
    const direct = candidate('up-a', 'model');
    const alias = candidate('up-a', 'model', { reasoning: { effort: 'low' } });

    expect(narrowCandidatesByAffinity(
      [direct, alias],
      [evidence(direct, 'force'), evidence(alias, 'force'), evidence(alias)],
    )).toEqual([alias, direct]);
  });

  test('fails unavailable and conflicting force affinity', () => {
    const first = candidate('up-a', 'model');
    const second = candidate('up-b', 'model');

    expect(narrowCandidatesByAffinity([first], [evidence(second, 'force')])).toMatchObject({ kind: 'routing-unavailable' });
    expect(narrowCandidatesByAffinity([first, second], [
      evidence(first, 'force'),
      evidence(second, 'force'),
    ])).toMatchObject({ kind: 'routing-unavailable' });
  });
});
