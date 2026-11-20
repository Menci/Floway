import { expect, test } from 'vitest';

import { analyze } from '../../src/test-health/analyze.ts';
import type { JobObservation } from '../../src/test-health/collect.ts';

const TESTS = [
  { project: 'p', file: '__tests__/a_test.ts', name: 'steady' },
  { project: 'p', file: '__tests__/a_test.ts', name: 'racy' },
  { project: 'p', file: '__tests__/b_test.ts', name: 'fixed' },
];

const job = (runId: number, commit: string, createdAt: string, results: Partial<JobObservation>): JobObservation => ({
  runId, attempt: 1, headSha: commit, testedCommit: commit, branch: 'main', event: 'push', createdAt, job: 'test',
  source: 'logs', cleanFiles: [], failures: [], ...results,
});

// c1 and c3 are distinct commits carrying one tree, as a rerun or a revert does.
const treeOf = (commit: string): string | undefined => ({ c1: 't1', c3: 't1', c2: 't2' })[commit];

test('only a failure beside a clean pass on the same tree is flaky, and file errors and annotations never count as passes', () => {
  const health = new Map(analyze(TESTS, [
    job(1, 'c1', '2026-01-01', { failures: [{ key: 'p|__tests__/a_test.ts|racy', error: 'timeout' }, { key: 'p|__tests__/b_test.ts', error: 'SyntaxError' }] }),
    job(2, 'c3', '2026-01-02', { cleanFiles: ['p|__tests__/a_test.ts'] }),
    job(3, 'c2', '2026-01-03', { cleanFiles: ['p|__tests__/a_test.ts', 'p|__tests__/b_test.ts'] }),
    job(4, 'c0', '2025-12-31', { source: 'annotations', failures: [{ key: 'p|__tests__/b_test.ts|fixed', error: 'boom' }, { key: 'gone|__tests__/x_test.ts|deleted', error: 'x' }] }),
  ], treeOf).map(entry => [entry.key, entry]));

  expect(health.get('p|__tests__/a_test.ts|steady')!.outcomes.map(o => o.evidence)).toEqual(['file-passed', 'file-passed']);
  expect(health.get('p|__tests__/a_test.ts|racy')).toMatchObject({ splitTrees: ['t1'] });
  expect(health.get('p|__tests__/a_test.ts|racy')!.outcomes[0]).toMatchObject({ evidence: 'failed', error: 'timeout' });
  expect(health.get('p|__tests__/b_test.ts|fixed')).toMatchObject({ splitTrees: [] });
  expect(health.get('p|__tests__/b_test.ts|fixed')!.outcomes.map(o => o.evidence)).toEqual(['failed', 'file-error', 'file-passed']);
  expect(health.has('gone|__tests__/x_test.ts|deleted')).toBe(false);
});
