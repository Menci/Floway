import type { MessagesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { replaceHttpHeader } from '@floway-dev/provider';

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
 * Generic in the run-result type so the count_tokens boundary chain
 * (`Response`) and the streaming Anthropic Messages boundary chain (`ExecuteResult<...>`)
 * can share one definition, matching the established behavior where
 * x-initiator is set on every Copilot Anthropic Messages HTTP call.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/master/src/services/copilot/create-chat-completions.ts
 */

export const copilotAnthropicMessagesSetInitiatorHeader = defineStage<MessagesFacts, MessagesFacts, object, object>({
  name: 'copilotAnthropicMessagesSetInitiatorHeader',
  through: {
    request: { needs: ['request.provider.payload', 'request.http.headers'], consumes: ['request.http.headers'], provides: ['request.http.headers'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.provider.payload'];
    let headers = facts['request.http.headers'];

    const lastMessage = payload.messages[payload.messages.length - 1];
    let initiator: 'user' | 'agent';
    if (lastMessage?.role !== 'user') {
      initiator = 'agent';
    } else if (!Array.isArray(lastMessage.content)) {
      initiator = 'user';
    } else {
      initiator = lastMessage.content.some(block => block.type !== 'tool_result') ? 'user' : 'agent';
    }
    headers = replaceHttpHeader(headers, 'x-initiator', initiator);

    return move({ ...await next(move({ ...facts, 'request.http.headers': headers })) });

  },
});
