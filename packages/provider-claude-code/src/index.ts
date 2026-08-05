import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createClaudeCodeProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const claudeCodeProviderModule: ProviderModule = {
  create: createClaudeCodeProvider,
  // https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L421-L444
  inboundHeaderAllowlist: [
    'accept',
    /^x-stainless-(?:retry-count|timeout|lang|package-version|os|arch|runtime|runtime-version|helper-method)$/,
    'anthropic-dangerous-direct-browser-access',
    'anthropic-version',
    'x-app',
    'accept-language',
    'sec-fetch-mode',
    'user-agent',
    'content-type',
    'accept-encoding',
    'x-claude-code-session-id',
    'x-client-request-id',
  ],
  defaultFlags: CLAUDE_CODE_DEFAULT_FLAGS,
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
export * from './interceptors/messages/system-blocks.ts';
export * from './pricing.ts';
export * from './fetch.ts';
export * from './provider.ts';
