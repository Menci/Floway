import type { CopilotMessagesBoundaryInterceptor } from './types.ts';

const isContextWindowError = (text: string): boolean => text.includes('Request body is too large for model context window') || text.includes('context_length_exceeded');

/**
 * Copilot's `/v1/messages` endpoint reports context-window failures with an
 * Anthropic-shape body carrying a Copilot-specific message string; Claude
 * Code's detector matches on the message substring alone (case-insensitive
 * `error.message.toLowerCase().includes('prompt is too long')`), so we
 * rewrite this body to lead with that phrase and trigger auto-compaction.
 * The detector, string constants, and matching envelope live in
 * `@floway-dev/translate/shared/messages/context-window-error.ts` — see the
 * comment on `PROMPT_TOO_LONG_MESSAGE` there for the client-bundle
 * evidence. This interceptor exists in addition because Copilot's Messages
 * endpoint never traverses the `messages-via-*` translation pairs.
 */
export const rewriteContextWindowError: CopilotMessagesBoundaryInterceptor = async (_ctx, _request, run) => {
  const result = await run();
  if (result.type !== 'api-error' || result.source !== 'upstream') return result;

  const body = new TextDecoder().decode(result.body);
  if (!isContextWindowError(body)) return result;

  return {
    ...result,
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.',
        },
      }),
    ),
  };
};
