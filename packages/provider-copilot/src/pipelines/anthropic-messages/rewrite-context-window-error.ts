import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError, PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';

// Claude Code triggers compaction from the canonical Anthropic error message.
// https://docs.claude.com/en/docs/claude-code/common-workflows#prompt-too-long
export const rewriteContextWindowError = defineCopilotStage({
  name: 'copilot.anthropicMessages.rewriteContextWindowError',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.anthropicMessages'], provides: ['response.anthropicMessages'], consumes: [] },
  },
  execute: transform(() => ({
    response(facts) {
      const outcome = facts['response.anthropicMessages'];
      if (outcome.kind !== 'error' || outcome.source !== 'upstream') return facts;
      const body = JSON.stringify(outcome.error);
      if (!body.includes('Request body is too large for model context window') && !body.includes('context_length_exceeded')) return facts;
      const error = formatAnthropicMessagesError(400, PROMPT_TOO_LONG_MESSAGE, { type: 'invalid_request_error' });
      return { ...facts, 'response.anthropicMessages': move({ ...outcome, error }) };
    },
  })),
});
