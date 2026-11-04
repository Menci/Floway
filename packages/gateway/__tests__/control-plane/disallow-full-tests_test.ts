import { expect, test } from 'vitest';

// A trap. Any run that names this file was produced by expanding a glob over
// the test tree, because no one hand-writes this path. The Vitest and ESLint
// configs refuse such a run before a single test is collected; this body only
// exists so that the file is a valid, trivially passing test where CI collects
// the complete suite.
test('the suite must be named, not matched', () => {
  expect(true).toBe(true);
});
