import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    name: '@floway-dev/dump',
    include: ['__tests__/**/*_test.ts'],
    environment: 'node',
  },
});
