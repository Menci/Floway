import { expect, test } from 'vitest';

// floway-test-trap — tripped by the Vitest and ESLint configs, never by a test.
//
// Any run that names this file came from expanding a pattern over the test
// tree: no one hand-writes this path. The configs refuse such a run while they
// load, before a test is collected. The body below exists only so the file is a
// valid, trivially passing test wherever CI collects the complete suite.
//
// Each trap carries its own filename on purpose, so one `--exclude` cannot hide
// the whole set.
test('name-the-suite-in-proxy', () => {
  expect(true).toBe(true);
});
