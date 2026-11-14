import type { ChatCompletionsFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { replaceHttpHeader } from '@floway-dev/provider';

/**
 * Copilot's OpenAI Chat Completions endpoint requires the private
 * `copilot-vision-request: true` header before it accepts OpenAI-style
 * `image_url` content parts; without it images are silently dropped or
 * rejected.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
 */

export const copilotOpenAIChatCompletionsSetVisionHeader = defineStage<ChatCompletionsFacts, ChatCompletionsFacts, object, object>({
  name: 'copilotOpenAIChatCompletionsSetVisionHeader',
  through: {
    request: { needs: ['request.provider.payload', 'request.http.headers'], consumes: ['request.http.headers'], provides: ['request.http.headers'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.provider.payload'];
    let headers = facts['request.http.headers'];

    const hasImage = payload.messages.some(
      message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'),
    );
    if (hasImage) headers = replaceHttpHeader(headers, 'copilot-vision-request', 'true');

    return move({ ...await next(move({ ...facts, 'request.http.headers': headers })) });

  },
});
