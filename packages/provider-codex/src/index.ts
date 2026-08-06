import { assertCodexUpstreamRecord } from './config.ts';
import { CODEX_DEFAULT_FLAGS } from './defaults.ts';
import { createCodexProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const codexProviderModule: ProviderModule = {
  create: createCodexProvider,
  modelCatalogIdentity: record => {
    assertCodexUpstreamRecord(record);
    return record.config;
  },
  modelRefreshIdentity: record => {
    assertCodexUpstreamRecord(record);
    return { config: record.config, state: record.state };
  },
  defaultFlags: CODEX_DEFAULT_FLAGS,
};

export * from './access-token.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
