import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*_test.ts'],
    testTimeout: 10_000,
  },
});
