import { defineCopilotStage } from '../facts.ts';
import { readBetaHeaders } from './read-beta-headers.ts';
import { deleteHeader, setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
const ALLOWED_ANTHROPIC_BETAS = new Set([
  INTERLEAVED_THINKING_BETA,
  CONTEXT_MANAGEMENT_BETA,
  'advanced-tool-use-2025-11-20',
]);
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts#L262-L282
// https://github.com/microsoft/vscode/blob/a234109a108ad2ca78b7d0883688b0a84e3fab42/extensions/copilot/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L413-L427
export const normalizeAnthropicBeta = defineCopilotStage({
  name: 'copilot.anthropicMessages.normalizeAnthropicBeta',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      const request = facts['request.http'];
      const requested = readBetaHeaders(request.headers);
      const normalized = new Set(requested.filter(beta => ALLOWED_ANTHROPIC_BETAS.has(beta)));
      if (requested.length === 0 && payload.thinking?.type === 'enabled' && payload.thinking.budget_tokens) {
        normalized.add(INTERLEAVED_THINKING_BETA);
      }
      if ('context_management' in payload && payload.context_management !== undefined) normalized.add(CONTEXT_MANAGEMENT_BETA);
      const headers = normalized.size === 0
        ? deleteHeader(request.headers, 'anthropic-beta')
        : setHeader(request.headers, 'anthropic-beta', [...normalized].join(','));
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
