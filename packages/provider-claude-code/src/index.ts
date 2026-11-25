import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createClaudeCodeProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const claudeCodeProviderModule: ProviderModule = {
  create: createClaudeCodeProvider,
  defaultFlags: CLAUDE_CODE_DEFAULT_FLAGS,
};

export * from './config.ts';
export { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
export { getClaudeCodeProvidedModels } from './models.ts';
export { runClaudeCodeScheduledTask } from './scheduled.ts';
export * from './state.ts';
export * from './constants.ts';
export * from './access-token.ts';
export * from './auth/identity.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './usage-probe.ts';
export { createClaudeCodeService, persistClaudeCodeUsageProbe, type ClaudeCodeService, type ClaudeCodeServices } from './service.ts';
export * from './detection.ts';
export * from './headers.ts';
export * from './log.ts';
export * from './quota.ts';
export { claudeCodePipelines } from './pipelines/index.ts';
export * from './interceptors/anthropic-messages/system-blocks.ts';
export * from './pricing.ts';
export * from './fetch.ts';
export * from './provider.ts';

export { claudeCodeProbeMetrics } from './upstream-metrics.ts';
