import type { JobObservation } from './collect.ts';
import { fileKey, testKey } from './log.ts';

export interface CurrentTest {
  project: string;
  /** Path relative to the project root, as the reporter prints it. */
  file: string;
  name: string;
}

export interface Outcome {
  runId: number;
  attempt: number;
  /** The tree under test: the merge commit for pull requests, the head otherwise. */
  commit: string;
  branch: string;
  createdAt: string;
  passed: boolean;
}

export interface TestHealth {
  key: string;
  runs: number;
  failures: number;
  /** Commits on which the test both passed and failed. */
  splitCommits: string[];
  /** Distinct branches the failures came from. */
  failingBranches: string[];
  outcomes: Outcome[];
}

/**
 * Folds job observations into one outcome per test per run attempt. A test
 * counts as run in a job when its file finished there; it failed when the
 * reporter named it, or its file failed outside any test. Annotation-only
 * observations predate log retention and record failures alone.
 */
export const analyze = (tests: readonly CurrentTest[], observations: readonly JobObservation[]): TestHealth[] => {
  const byFile = new Map<string, string[]>();
  for (const test of tests) {
    const file = fileKey(test.project, test.file);
    byFile.set(file, [...byFile.get(file) ?? [], testKey(test.project, test.file, test.name)]);
  }
  const current = new Set(byFile.values().flatMap(keys => keys));
  const outcomes = new Map<string, Map<string, Outcome>>();
  const record = (key: string, observation: JobObservation, passed: boolean): void => {
    const attemptKey = `${observation.runId}/${observation.attempt}`;
    const perTest = outcomes.get(key) ?? new Map<string, Outcome>();
    outcomes.set(key, perTest);
    const previous = perTest.get(attemptKey);
    perTest.set(attemptKey, {
      runId: observation.runId,
      attempt: observation.attempt,
      commit: observation.testedCommit ?? observation.headSha,
      branch: observation.branch,
      createdAt: observation.createdAt,
      passed: passed && (previous?.passed ?? true),
    });
  };
  for (const observation of observations) {
    const failed = new Set(observation.failedTests);
    for (const key of failed) if (current.has(key)) record(key, observation, false);
    for (const file of observation.failedFiles) for (const key of byFile.get(file) ?? []) record(key, observation, false);
    for (const file of observation.finishedFiles) {
      for (const key of byFile.get(file) ?? []) if (!failed.has(key)) record(key, observation, true);
    }
  }
  return [...outcomes].map(([key, perTest]) => {
    const list = [...perTest.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attempt - b.attempt);
    const byCommit = Map.groupBy(list, outcome => outcome.commit);
    return {
      key,
      runs: list.length,
      failures: list.filter(outcome => !outcome.passed).length,
      splitCommits: [...byCommit].filter(([, group]) => group.some(o => o.passed) && group.some(o => !o.passed)).map(([commit]) => commit),
      failingBranches: [...new Set(list.filter(outcome => !outcome.passed).map(outcome => outcome.branch))],
      outcomes: list,
    };
  });
};
