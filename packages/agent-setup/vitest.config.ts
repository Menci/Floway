import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    include: ['__tests__/**/*_test.ts'],
    exclude: ['__tests__/installers/integration/**'],
    environment: 'node',
    // Several suites here run a real shell: the installer fragments execute under
    // `bash` or `pwsh` with a 10 s spawn watchdog. Vitest's 5 s default is
    // shorter than that watchdog, so a cold `pwsh` start on a loaded runner fails
    // the case before the process itself gives up, which reads as a timeout in a
    // case that is merely slow. This sits above the spawn timeout so the child's
    // own deadline stays the one that reports a hang.
    testTimeout: 20_000,
  },
});
