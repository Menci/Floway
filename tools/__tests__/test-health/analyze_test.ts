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
  source: 'logs', finishedFiles: [], failedTests: [], failedFiles: [], ...results,
});

test('failures split by commit separate nondeterminism from breakage, and expired runs count only failures', () => {
  const health = new Map(analyze(TESTS, [
    job(1, 'c1', '2026-01-01', { finishedFiles: ['p|__tests__/a_test.ts'], failedTests: ['p|__tests__/a_test.ts|racy'], failedFiles: ['p|__tests__/b_test.ts'] }),
    job(2, 'c1', '2026-01-02', { finishedFiles: ['p|__tests__/a_test.ts'] }),
    job(3, 'c2', '2026-01-03', { finishedFiles: ['p|__tests__/a_test.ts', 'p|__tests__/b_test.ts'] }),
    job(4, 'c0', '2025-12-31', { source: 'annotations', failedTests: ['p|__tests__/b_test.ts|fixed', 'gone|__tests__/x_test.ts|deleted'] }),
  ]).map(entry => [entry.key, entry]));

  expect(health.get('p|__tests__/a_test.ts|steady')).toMatchObject({ runs: 3, failures: 0 });
  expect(health.get('p|__tests__/a_test.ts|racy')).toMatchObject({ runs: 3, failures: 1, splitCommits: ['c1'] });
  expect(health.get('p|__tests__/b_test.ts|fixed')).toMatchObject({ runs: 3, failures: 2, splitCommits: [] });
  expect(health.has('gone|__tests__/x_test.ts|deleted')).toBe(false);
});
