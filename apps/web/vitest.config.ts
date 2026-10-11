import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*_test.{ts,tsx}'],
    environment: 'happy-dom',
    server: { deps: { inline: [/@fluentui\//, /@griffel\//, /tabster/] } },
    setupFiles: ['./__tests__/setup.ts'],
  },
});
