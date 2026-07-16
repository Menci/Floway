import type { CopilotMessagesBoundaryInterceptor } from './types.ts';
import { buildPromptTooLongBody } from '@floway-dev/protocols/messages';

const isContextWindowError = (text: string): boolean => text.includes('Request body is too large for model context window') || text.includes('context_length_exceeded');

/**
 * Copilot's `/v1/messages` endpoint reports context-window failures with an
 * Anthropic-shape body carrying a Copilot-specific message string; Claude
 * Code's detector matches on the message substring alone (case-insensitive
 * `error.message.toLowerCase().includes('prompt is too long')`), so we
 * rewrite this body to the canonical prompt-too-long envelope and trigger
 * auto-compaction. The envelope + client-bundle evidence live in
 * `@floway-dev/protocols/messages` (`buildPromptTooLongBody` /
 * `PROMPT_TOO_LONG_MESSAGE`). This interceptor exists in addition to the
 * translate-layer rewriter because Copilot's Messages endpoint never
 * traverses the `messages-via-*` translation pairs — the Copilot Messages
 * substring set here (`Request body is too large...`) is disjoint from
 * the Responses/Chat shapes those pairs match on.
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
    body: buildPromptTooLongBody(),
  };
};
