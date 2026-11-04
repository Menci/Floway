import { defineConfig } from 'vitest/config';

import { requireNamedTestFiles } from '../../tools/src/verification-scope.ts';

requireNamedTestFiles();

export default defineConfig({
  test: {
    include: ['__tests__/**/*_test.{ts,tsx}'],
    environment: 'happy-dom',
    server: { deps: { inline: [/@fluentui\//, /@griffel\//, /tabster/] } },
    setupFiles: ['./__tests__/setup.ts'],
  },
});
