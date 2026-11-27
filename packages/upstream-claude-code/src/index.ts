import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { getClaudeCodeModels } from './models.ts';
import { runClaudeCodeScheduledTask } from './scheduled.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const claudeCodeUpstreamModule: UpstreamModule = {
  defaultFlags: CLAUDE_CODE_DEFAULT_FLAGS,
  getModels: getClaudeCodeModels,
  runScheduledTask: runClaudeCodeScheduledTask,
};

export * from './config.ts';
export * from './state.ts';
export * from './constants.ts';
export * from './access-token.ts';
export * from './auth/identity.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './usage-probe.ts';
export * from './detection.ts';
export * from './headers.ts';
export * from './log.ts';
export * from './quota.ts';
export * from './pipelines/anthropic-messages/system-blocks.ts';
export * from './pricing.ts';

export { claudeCodePipelines } from './pipelines/anthropic-messages/index.ts';
export { createClaudeCodeService, type ClaudeCodeService, type ClaudeCodeServices } from './service.ts';
export { claudeCodeProbeMetrics } from './upstream-metrics.ts';
