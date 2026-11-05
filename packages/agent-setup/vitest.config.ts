import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    include: ['__tests__/**/*_test.ts'],
    exclude: ['__tests__/installers/integration/**'],
    environment: 'node',
    // Every installer test shells out to bash or pwsh with its own 10s
    // spawnSync budget, so the default 5s test timeout always fires first and
    // reports a hang the test never had. PowerShell's cold start under
    // workspace-parallel load is what actually pushes past 5s.
    testTimeout: 30_000,
  },
});
