import { expect, it } from 'vitest';

import { createCandidateRegistry } from '../../../src/data-plane/pipeline/candidates.ts';
import { stubModelCandidate } from '@floway-dev/test-utils';

it('preserves exact candidate identity across same-upstream variants and later registrations', () => {
  const registry = createCandidateRegistry();
  const first = stubModelCandidate({ model: { id: 'first' } });
  const second = { ...first, rules: { verbosity: 'high' } };
  const later = stubModelCandidate({ model: { id: 'later' } });
  const [firstSelector, secondSelector] = registry.rememberCandidates([first, second]);
  const [laterSelector] = registry.rememberCandidates([later]);
  expect([firstSelector!.candidateId, secondSelector!.candidateId, laterSelector!.candidateId]).toEqual([0, 1, 2]);
  expect(registry.resolveAttempt(firstSelector!)).toBe(first);
  expect(registry.resolveAttempt(secondSelector!)).toBe(second);
  expect(registry.resolveAttempt(laterSelector!)).toBe(later);
  expect(() => registry.resolveAttempt({ ...firstSelector!, candidateId: 99 })).toThrow('nothing live for candidate 99');
});
