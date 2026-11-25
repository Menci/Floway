import { stripHeaders } from '@floway-dev/provider';

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L421-L444
export const claudeCodeInboundHeaders = [
  'accept',
  /^x-stainless-(?:retry-count|timeout|lang|package-version|os|arch|runtime|runtime-version|helper-method)$/,
  'anthropic-beta',
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
] as const;

export const stripClaudeCodeHeaders = stripHeaders('claude-code.strip-headers', name =>
  claudeCodeInboundHeaders.some(rule => typeof rule === 'string' ? name === rule : rule.test(name)));
