import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createClaudeCodeProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const claudeCodeProvider: ProviderModule = {
  create: createClaudeCodeProvider,
  defaultFlags: CLAUDE_CODE_DEFAULT_FLAGS,
};

export * from './config.ts';
export * from './state.ts';
export * from './constants.ts';
export * from './access-token-cache.ts';
export * from './auth/identity.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './auth/usage-probe.ts';
export * from './detection.ts';
export * from './headers.ts';
export * from './log.ts';
export * from './quota.ts';
export * from './system-blocks.ts';
export * from './models.ts';
export * from './pricing.ts';
export * from './fetch.ts';
export * from './provider.ts';
export * from './types.ts';
export type { ClaudeCodeMessagesBoundaryCtx } from './interceptors/messages/index.ts';
export { claudeCodeMessagesChain } from './interceptors/messages/index.ts';
