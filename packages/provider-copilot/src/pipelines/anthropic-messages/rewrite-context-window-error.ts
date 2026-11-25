import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { setHeader } from '@floway-dev/http';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';

// Claude Code's detector recognizes this exact message and starts auto-compaction.
// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-messages.ts
export const rewriteContextWindowError = defineCopilotStage({
  name: 'copilot.anthropicMessages.rewriteContextWindowError',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.http', 'response.anthropicMessages'], provides: ['response.http', 'response.anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const http = back['response.http'];
    const outcome = back['response.anthropicMessages'];
    if (http === null || outcome.kind !== 'error' || outcome.source !== 'upstream') return back;

    const error = JSON.stringify(outcome.error);
    if (!error.includes('Request body is too large for model context window') && !error.includes('context_length_exceeded')) return back;
    const headers = setHeader(http.headers, 'content-type', 'application/json');
    return {
      ...back,
      'response.http': { ...http, status: 400, statusText: 'Bad Request', headers },
      'response.anthropicMessages': { ...outcome, error: formatAnthropicMessagesError(400, PROMPT_TOO_LONG_MESSAGE) },
    };
  },
});
