import type { AnthropicMessagesAssistantMessage, AnthropicMessagesUserMessage } from '@floway-dev/protocols/anthropic-messages';

/**
 * Copilot rejects Anthropic `image` blocks as plain text unless the private
 * `copilot-vision-request: true` header is set. Detection must scan the final
 * post-mutation payload after the other payload stages have run
 * and cover both the top-level `message.content` and the nested
 * `tool_result.content[]` shape; Anthropic allows images in both positions.
 *
 * Both the streaming Messages pipeline and its count-token pipeline use this
 * detector.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/1f6b98924ae092db9b2010846c32e5cbf10817df
 */
export const copilotAnthropicContentHasImage = (content: AnthropicMessagesUserMessage['content'] | AnthropicMessagesAssistantMessage['content']): boolean => {
  if (!Array.isArray(content)) return false;
  return content.some(block => {
    if (block.type === 'image') return true;
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return block.content.some(inner => inner.type === 'image');
    }
    return false;
  });
};
