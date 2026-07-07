import { CODEX_DEFAULT_FLAGS } from './defaults.ts';
import { createCodexProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const codexProvider: ProviderModule = {
  create: createCodexProvider,
  defaultFlags: CODEX_DEFAULT_FLAGS,
};

export * from './access-token-cache.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
export { createCodexProvider } from './provider.ts';
