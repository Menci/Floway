import Vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Vue plugin is required for any test that mounts an SFC; logic-only
  // tests don't need it, but adding it here is cheap and lets component
  // tests live next to the rest.
  plugins: [Vue()],
  test: {
    // happy-dom provides DOM + EventSource for the dump-subscription
    // composable's tests. Node-env worked while the composable accepted
    // a factory for injection, but that DI surface existed only for the
    // tests — switching env removes the need for it.
    environment: 'happy-dom',
    include: ['src/**/*_test.ts'],
  },
});
