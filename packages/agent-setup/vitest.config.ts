import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    include: ['__tests__/**/*_test.ts'],
    exclude: ['__tests__/installers/integration/**'],
    environment: 'node',
  },
});
