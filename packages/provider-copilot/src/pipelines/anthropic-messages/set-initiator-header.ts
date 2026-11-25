import type { AnthropicMessagesOperation } from './operations.ts';
import { rewriteHeaders } from '../shared/rewrite-request.ts';
import { setHeader } from '@floway-dev/http';

/**
 * Copilot's `x-initiator` header distinguishes turns that the human user just
 * triggered (`user`) from turns the agent triggered to consume a tool result
 * (`agent`). The header gates Copilot-side abuse controls and conversation
 * accounting. We classify by the last message: a user turn whose content
 * mixes plain blocks with tool_results is still user-initiated; a user turn
 * whose content is *only* tool_results is the agent consuming results, and
 * any assistant-final turn (which only happens on count-tokens replays) is
 * always agent.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/master/src/services/copilot/create-chat-completions.ts
 */

export const setInitiatorHeader = (operation: AnthropicMessagesOperation) => rewriteHeaders[operation]('setInitiatorHeader', (payload, headers) => {
  const last = payload.messages.at(-1);
  const user = last?.role === 'user' && (!Array.isArray(last.content) || last.content.some(block => block.type !== 'tool_result'));
  return setHeader(headers, 'x-initiator', user ? 'user' : 'agent');
});
