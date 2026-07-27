import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*_test.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      // `cloudflare:workers` is a workerd-only module; map it to a Node-
      // compatible stub so the platform-cloudflare unit tests can import
      // `DurableObject` without the workerd runtime present.
      'cloudflare:workers': new URL('./__tests__/test-utils/cloudflare-workers-stub.ts', import.meta.url).pathname,
    },
  },
});
