import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createClaudeCodeProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const claudeCodeProviderModule: ProviderModule = {
  create: createClaudeCodeProvider,
  defaultFlags: CLAUDE_CODE_DEFAULT_FLAGS,
};

export * from './config.ts';
export * from './state.ts';
export * from './constants.ts';
export { claudeCodePipelines } from './pipelines.ts';
export {
  claudeCodeService,
  createClaudeCodeService,
  ensureClaudeCodeAccessToken,
  persistClaudeCodeUsageProbe,
  type ClaudeCodeService,
  type ClaudeCodeServices,
} from './service.ts';
export * from './auth/identity.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './usage-probe.ts';
export * from './detection.ts';
export * from './headers.ts';
export * from './log.ts';
export * from './quota.ts';
export * from './stages/anthropic-messages/system-blocks.ts';
export * from './pricing.ts';
export * from './provider.ts';

export { claudeCodeProbeMetrics } from './upstream-metrics.ts';
