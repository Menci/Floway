import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/platform-cloudflare/vitest.config.ts',
      'apps/platform-node/vitest.config.ts',
      'apps/web/vitest.config.ts',
      'packages/gateway/vitest.config.ts',
      'packages/http/vitest.config.ts',
      'packages/platform/vitest.config.ts',
      'packages/protocols/vitest.config.ts',
      'packages/provider/vitest.config.ts',
      'packages/proxy/vitest.config.ts',
      'packages/translate/vitest.config.ts',
      'packages/interceptor/vitest.config.ts',
      'packages/provider-azure/vitest.config.ts',
      'packages/provider-claude-code/vitest.config.ts',
      'packages/provider-codex/vitest.config.ts',
      'packages/provider-copilot/vitest.config.ts',
      'packages/provider-cursor/vitest.config.ts',
      'packages/provider-custom/vitest.config.ts',
    ],
  },
});
