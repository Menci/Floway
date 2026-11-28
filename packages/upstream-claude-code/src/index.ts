import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { resolveUpstreamMetricDisplay } from './upstream-metrics.ts';
import { createClaudeCodeUpstream } from './upstream.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const claudeCodeUpstreamModule: UpstreamModule = {
  create: createClaudeCodeUpstream,
  defaultFlags: CLAUDE_CODE_DEFAULT_FLAGS,
  resolveUpstreamMetricDisplay,
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
export * from './interceptors/anthropic-messages/system-blocks.ts';
export * from './pricing.ts';
export * from './fetch.ts';
export * from './upstream.ts';

export { claudeCodeProbeMetrics } from './upstream-metrics.ts';
