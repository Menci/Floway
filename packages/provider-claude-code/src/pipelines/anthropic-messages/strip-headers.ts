import { stripHeaders } from '@floway-dev/provider';

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L421-L444
const ALLOWED_HEADERS = new Set([
  'accept',
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
]);

const STAINLESS_HEADER = /^x-stainless-(?:retry-count|timeout|lang|package-version|os|arch|runtime|runtime-version|helper-method)$/;

export const stripClaudeCodeHeaders = stripHeaders('claude-code.anthropic-messages.strip-headers', name =>
  ALLOWED_HEADERS.has(name) || STAINLESS_HEADER.test(name));
