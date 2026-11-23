import { unchanged } from '../shared/stages.ts';
import { defineStage, transform, type FactValue } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderAnthropicMessagesOutput } from '@floway-dev/provider';

const matchesContextWindowError = (value: FactValue): boolean => typeof value === 'string'
  && (value.includes('Request body is too large for model context window') || value.includes('context_length_exceeded'));

const isCopilotContextWindowError = (error: FactValue): boolean => {
  if (typeof error !== 'object' || error === null) return matchesContextWindowError(error);
  if ('type' in error && error.type === 'upstream_invalid_stream') return false;
  if ('error' in error && typeof error.error === 'object' && error.error !== null) {
    return isCopilotContextWindowError(error.error);
  }
  return ('message' in error && matchesContextWindowError(error.message))
    || ('code' in error && matchesContextWindowError(error.code))
    || ('type' in error && matchesContextWindowError(error.type))
    || ('error' in error && matchesContextWindowError(error.error));
};

/**
 * Copilot's `/v1/messages` endpoint reports context-window failures with an
 * Anthropic-shape body carrying a Copilot-specific message string; Claude
 * Code's detector matches on the message substring alone (case-insensitive
 * `error.message.toLowerCase().includes('prompt is too long')`), so we
 * rewrite this body to the canonical prompt-too-long envelope and trigger
 * auto-compaction. The envelope + client-bundle evidence live in
 * `@floway-dev/protocols/anthropic-messages` (`buildPromptTooLongBody` /
 * `PROMPT_TOO_LONG_MESSAGE`). This stage exists in addition to the
 * translate-layer rewriter because Copilot's Anthropic Messages endpoint never
 * traverses the `anthropic-messages-via-*` translation pairs — the Copilot Anthropic Messages
 * substring set here (`Request body is too large...`) is disjoint from
 * the OpenAI Responses/OpenAI Chat Completions shapes those pairs match on.
 */
export const rewriteContextWindowError = defineStage<{}, {}, ProviderAnthropicMessagesOutput, ProviderAnthropicMessagesOutput>({
  name: 'rewrite-context-window-error',
  through: {
    request: unchanged,
    response: { needs: ['response.http', 'response.anthropicMessages'], consumes: [], provides: ['response.http', 'response.anthropicMessages'] },
  },
  execute: transform(() => ({
    response(back) {
      const http = back['response.http'];
      const outcome = back['response.anthropicMessages'];
      if (outcome.kind !== 'error' || outcome.source !== 'upstream' || http.transportError !== undefined || !isCopilotContextWindowError(outcome.error)) return back;
      return {
        ...back,
        'response.http': {
          ...http,
          status: 400,
          statusText: '',
          headers: [['content-type', 'application/json']],
          body: null,
        },
        'response.anthropicMessages': {
          ...outcome,
          error: {
            type: 'error',
            error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE },
          },
        },
      };
    },
  })),
});
