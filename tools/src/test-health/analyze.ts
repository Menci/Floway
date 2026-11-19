import type { JobObservation } from './collect.ts';
import { fileKey, testKey } from './log.ts';

export interface CurrentTest {
  project: string;
  /** Path relative to the project root, as the reporter prints it. */
  file: string;
  name: string;
}

export type Evidence =
  /** The reporter named this test as failed. */
  | 'failed'
  /** The file failed outside any test, so this test never ran. */
  | 'file-error'
  /** The file finished with every test passing and none skipped. */
  | 'file-passed';

export interface Outcome {
  runId: number;
  attempt: number;
  /** The commit the job checked out: the merge commit for pull requests, the head otherwise. */
  commit: string;
  branch: string;
  createdAt: string;
  source: JobObservation['source'];
  evidence: Evidence;
  error: string | undefined;
}

export interface TestHealth {
  key: string;
  outcomes: Outcome[];
  /** Source trees on which the test both failed and passed. */
  splitTrees: string[];
}

/**
 * Names the exact source a commit carries. Undefined means the commit is not
 * available locally, in which case the commit stands for itself and only a
 * rerun of the same checkout can match it.
 */
export type TreeOf = (commit: string) => string | undefined;

/**
 * Folds job observations into one outcome per test per run attempt, keeping
 * the strongest evidence a job gave. Logs never name a passing test, so a pass
 * is inferred from its file finishing clean; a test added or renamed later
 * inherits its file's earlier passes, which can only overstate health.
 * Failures are exact. Annotation-only observations record failures alone.
 */
export const analyze = (tests: readonly CurrentTest[], observations: readonly JobObservation[], treeOf: TreeOf): TestHealth[] => {
  const byFile = new Map<string, string[]>();
  for (const test of tests) {
    const file = fileKey(test.project, test.file);
    byFile.set(file, [...byFile.get(file) ?? [], testKey(test.project, test.file, test.name)]);
  }
  const current = new Set(byFile.values().flatMap(keys => keys));
  const outcomes = new Map<string, Map<string, Outcome>>();
  const rank: Record<Evidence, number> = { 'failed': 2, 'file-error': 1, 'file-passed': 0 };
  const record = (key: string, observation: JobObservation, evidence: Evidence, error?: string): void => {
    const attemptKey = `${observation.runId}/${observation.attempt}`;
    const perTest = outcomes.get(key) ?? new Map<string, Outcome>();
    outcomes.set(key, perTest);
    const previous = perTest.get(attemptKey);
    if (previous !== undefined && rank[previous.evidence] >= rank[evidence]) return;
    perTest.set(attemptKey, {
      runId: observation.runId,
      attempt: observation.attempt,
      commit: observation.testedCommit ?? observation.headSha,
      branch: observation.branch,
      createdAt: observation.createdAt,
      source: observation.source,
      evidence,
      error,
    });
  };
  for (const observation of observations) {
    for (const { key, error } of observation.failures) {
      if (current.has(key)) record(key, observation, 'failed', error);
      for (const test of byFile.get(key) ?? []) record(test, observation, 'file-error', error);
    }
    for (const file of observation.cleanFiles) for (const key of byFile.get(file) ?? []) record(key, observation, 'file-passed');
  }
  return [...outcomes].map(([key, perTest]) => {
    const list = [...perTest.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attempt - b.attempt);
    const byTree = Map.groupBy(list, outcome => treeOf(outcome.commit) ?? outcome.commit);
    return {
      key,
      outcomes: list,
      splitTrees: [...byTree]
        .filter(([, group]) => group.some(o => o.evidence === 'failed') && group.some(o => o.evidence === 'file-passed'))
        .map(([tree]) => tree),
    };
  });
};
