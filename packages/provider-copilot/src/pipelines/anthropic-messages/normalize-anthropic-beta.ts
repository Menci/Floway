import type { AnthropicMessagesOperation } from './operations.ts';
import { rewriteHeaders } from '../shared/rewrite-headers.ts';
import { deleteHeader, getHeaders, setHeader, type HttpHeaders } from '@floway-dev/http';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';

const ALLOWED_ANTHROPIC_BETAS = new Set([
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'advanced-tool-use-2025-11-20',
]);
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

// Copilot rejects unknown beta values. Preserve the supported subset of the
// caller's Anthropic Messages beta intent, synthesize VS Code's thinking default only
// when the caller supplied no beta intent, and keep context_management paired
// with its required token.
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts#L262-L282
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L413-L427

export const callerAnthropicBetas = (headers: HttpHeaders): readonly string[] => getHeaders(headers, 'anthropic-beta').flatMap(value => {
  if (typeof value !== 'string') throw new TypeError('Anthropic beta header must be plain text');
  return parseAnthropicBetaHeader(value);
});

export const normalizeAnthropicBeta = (operation: AnthropicMessagesOperation) => rewriteHeaders(operation, 'normalizeAnthropicBeta', (payload, headers) => {
  const supplied = callerAnthropicBetas(headers);
  const betas = new Set(supplied.filter(beta => ALLOWED_ANTHROPIC_BETAS.has(beta)));
  if (supplied.length === 0 && payload.thinking?.type === 'enabled' && payload.thinking.budget_tokens) {
    betas.add(INTERLEAVED_THINKING_BETA);
  }
  if ('context_management' in payload && payload.context_management !== undefined) betas.add(CONTEXT_MANAGEMENT_BETA);
  return betas.size === 0 ? deleteHeader(headers, 'anthropic-beta') : setHeader(headers, 'anthropic-beta', [...betas].join(','));
});
