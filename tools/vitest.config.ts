import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tools',
    include: ['__tests__/**/*_test.ts'],
  },
});
