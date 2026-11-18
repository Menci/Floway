import { expect, test } from 'vitest';

import { parseAnnotationTitle, parseJobLog } from '../../src/test-health/log.ts';

// Abridged from a real `test (5/8)` job log: Actions timestamps, ANSI colors,
// the checkout's commit probe, finished-file lines, and the failure summary.
const LOG = [
  '\uFEFF2026-11-18T12:53:14.1Z [command]/usr/bin/git log -1 --format=%H',
  '2026-11-18T12:53:14.2Z 217b54af76d50eda968dc54ea31c40c648b4cb2f',
  '2026-11-18T12:53:50.8Z  \x1b[32m✓\x1b[39m \x1b[30m\x1b[45m @floway-dev/agent-setup \x1b[49m\x1b[39m __tests__/installers/bash/pi_test.ts \x1b[2m(\x1b[22m\x1b[2m5 tests\x1b[22m\x1b[2m)\x1b[22m 288ms',
  '2026-11-18T12:53:51.0Z    ✓ a slow inner test  461ms',
  '2026-11-18T12:53:52.0Z  ❯  @floway-dev/gateway  __tests__/migrations/canonical-flag-ids_test.ts (1 test | 1 failed) 110ms',
  '2026-11-18T12:53:53.0Z  ❯  @floway-dev/web  __tests__/routes/broken_test.tsx (0 test)',
  '2026-11-18T12:54:47.7Z  FAIL   @floway-dev/gateway  __tests__/migrations/canonical-flag-ids_test.ts > the canonical flag-id migration renames ids > keeps a boolean',
  '2026-11-18T12:54:47.8Z  FAIL   @floway-dev/web  __tests__/routes/broken_test.tsx [ __tests__/routes/broken_test.tsx ]',
  '2026-11-18T12:54:47.9Z  ❯ modelOverrides __tests__/migrations/canonical-flag-ids_test.ts:70:17',
].join('\n');

test('a job log yields its finished files, failed tests, file-level failures, and tested commit', () => {
  expect(parseJobLog(LOG)).toEqual({
    finishedFiles: [
      '@floway-dev/agent-setup|__tests__/installers/bash/pi_test.ts',
      '@floway-dev/gateway|__tests__/migrations/canonical-flag-ids_test.ts',
      '@floway-dev/web|__tests__/routes/broken_test.tsx',
    ],
    failedTests: ['@floway-dev/gateway|__tests__/migrations/canonical-flag-ids_test.ts|the canonical flag-id migration renames ids > keeps a boolean'],
    failedFiles: ['@floway-dev/web|__tests__/routes/broken_test.tsx'],
    testedCommit: '217b54af76d50eda968dc54ea31c40c648b4cb2f',
  });
});

test('an annotation title names its test, and a step-level annotation names none', () => {
  expect(parseAnnotationTitle('[@floway-dev/web] __tests__/components/usage/plot_test.ts > bucket callout figures > adds the disjoint counters'))
    .toBe('@floway-dev/web|__tests__/components/usage/plot_test.ts|bucket callout figures > adds the disjoint counters');
  expect(parseAnnotationTitle('')).toBeUndefined();
});
