import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/api/vitest.config.ts',
      'packages/protocols/vitest.config.ts',
      'packages/translate/vitest.config.ts',
    ],
  },
});
