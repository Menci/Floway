import type { MessagesBoundaryCtx } from './types.ts';
import type { MessagesAssistantMessage, MessagesUserMessage } from '@floway-dev/protocols/messages';

/**
 * Copilot rejects Anthropic `image` blocks as plain text unless the private
 * `copilot-vision-request: true` header is set. Detection must scan the final
 * post-mutation payload (after other Messages boundary interceptors have run)
 * and cover both the top-level `message.content` and the nested
 * `tool_result.content[]` shape; Anthropic allows images in both positions.
 *
 * Generic in the run-result type because the Copilot provider historically
 * applied equivalent vision detection to every Messages HTTP exchange (chat
 * AND count_tokens). Keeping a single generic interceptor lets both the streaming
 * Messages boundary chain (`ExecuteResult<...>`) and the count_tokens chain
 * (`Response`) share one definition.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/1f6b98924ae092db9b2010846c32e5cbf10817df
 */
const contentHasImage = (content: MessagesUserMessage['content'] | MessagesAssistantMessage['content']): boolean => {
  if (!Array.isArray(content)) return false;
  return content.some(block => {
    if (block.type === 'image') return true;
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return block.content.some(inner => inner.type === 'image');
    }
    return false;
  });
};

export const withVisionHeaderSet = async <TResult>(
  ctx: MessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (ctx.payload.messages.some(message => contentHasImage(message.content))) {
    ctx.headers.set('copilot-vision-request', 'true');
  }

  return await run();
};
