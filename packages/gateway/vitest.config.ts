import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*_test.ts'],
    // `setupAppTest` builds the full Hono app + memory D1 + admin session per
    // test; under workspace-parallel load that occasionally pushes past 10s.
    // 30s absorbs the contention without masking actual hangs.
    testTimeout: 30_000,
    setupFiles: ['./__tests__/vitest.setup.ts'],
  },
});
