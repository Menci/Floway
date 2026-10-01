import type { MessagesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesUserMessage } from '@floway-dev/protocols/anthropic-messages';
import { replaceHttpHeader } from '@floway-dev/provider';

/**
 * Copilot rejects Anthropic `image` blocks as plain text unless the private
 * `copilot-vision-request: true` header is set. Detection must scan the final
 * shaped request payload (after other Anthropic Messages boundary stages have run)
 * and cover both the top-level `message.content` and the nested
 * `tool_result.content[]` shape; Anthropic allows images in both positions.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/1f6b98924ae092db9b2010846c32e5cbf10817df
 */
const contentHasImage = (content: AnthropicMessagesUserMessage['content'] | AnthropicMessagesAssistantMessage['content']): boolean => {
  if (!Array.isArray(content)) return false;
  return content.some(block => {
    if (block.type === 'image') return true;
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return block.content.some(inner => inner.type === 'image');
    }
    return false;
  });
};

export const copilotAnthropicMessagesSetVisionHeader = defineStage<MessagesFacts, MessagesFacts, object, object>({
  name: 'copilotAnthropicMessagesSetVisionHeader',
  through: {
    request: { needs: ['request.provider.payload', 'request.http.headers'], consumes: ['request.http.headers'], provides: ['request.http.headers'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.provider.payload'];
    let headers = facts['request.http.headers'];

    if (payload.messages.some(message => contentHasImage(message.content))) {
      headers = replaceHttpHeader(headers, 'copilot-vision-request', 'true');
    }

    return move({ ...await next(move({ ...facts, 'request.http.headers': headers })) });

  },
});
