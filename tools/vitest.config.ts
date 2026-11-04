import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from './src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    name: 'tools',
    include: ['__tests__/**/*_test.ts'],
  },
});
