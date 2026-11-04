import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*_test.ts'],
    testTimeout: 10_000,
  },
});
