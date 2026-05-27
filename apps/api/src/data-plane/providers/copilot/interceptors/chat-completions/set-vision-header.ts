import type { ChatCompletionsInterceptor } from '../../../../llm/interceptors.ts';

/**
 * Copilot's Chat Completions endpoint requires the private
 * `copilot-vision-request: true` header before it accepts OpenAI-style
 * `image_url` content parts; without it images are silently dropped or
 * rejected.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/services/copilot/create-chat-completions.ts#L20-L24
 */
export const withVisionHeaderSet: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  const hasImage = ctx.payload.messages.some(
    message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'),
  );
  if (hasImage) ctx.headers['copilot-vision-request'] = 'true';

  return await run();
};
