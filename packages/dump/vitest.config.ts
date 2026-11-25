import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    name: 'dump',
    include: ['__tests__/**/*_test.ts'],
    environment: 'node',
  },
});
