import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    name: 'agent-setup-installers',
    include: ['__tests__/installers/integration/**/*_test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
