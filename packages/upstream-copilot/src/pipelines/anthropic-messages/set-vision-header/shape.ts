import type { HttpHeaders } from '@floway-dev/http';
import { setHeader } from '@floway-dev/http';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesPayload, AnthropicMessagesUserMessage } from '@floway-dev/protocols/anthropic-messages';

/**
 * Copilot rejects Anthropic `image` blocks as plain text unless the private
 * `copilot-vision-request: true` header is set. Detection must scan the final
 * post-mutation payload (after payload shaping)
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

export const visionHeaders = (payload: Pick<AnthropicMessagesPayload, 'messages' | 'metadata' | 'system' | 'thinking'>, headers: HttpHeaders): HttpHeaders =>
  payload.messages.some(message => contentHasImage(message.content)) ? setHeader(headers, 'copilot-vision-request', 'true') : headers;
