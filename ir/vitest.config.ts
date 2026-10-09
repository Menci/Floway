import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'ir', include: ['__tests__/**/*_test.ts'], environment: 'node' } });
