import { defineConfig } from 'vitest/config';

// The dashboard reads local time on purpose -- a reader's traffic is bucketed
// into their own day -- so a suite that exercises it samples whatever zone the
// machine is in. Pinning one here is what makes a green run here mean a green
// run anywhere: a fixture written against the ambient zone has passed locally
// and failed in CI, which reports the machine, not the code.
export default defineConfig({
  test: {
    env: { TZ: 'UTC' },
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
});
