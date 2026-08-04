import { CODEX_DEFAULT_FLAGS } from './defaults.ts';
import { createCodexProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const codexProviderModule: ProviderModule = {
  create: createCodexProvider,
  inboundHeaderAllowlist: [
    'session-id',
    'session_id',
    'thread-id',
    'x-client-request-id',
    'x-codex-turn-metadata',
    'x-codex-window-id',
  ],
  defaultFlags: CODEX_DEFAULT_FLAGS,
};

export * from './access-token.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
