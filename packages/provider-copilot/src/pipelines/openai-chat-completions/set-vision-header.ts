import { rewriteHeaders } from '../shared/rewrite-headers.ts';
import { setHeader } from '@floway-dev/http';

/**
 * Copilot's OpenAI Chat Completions endpoint requires the private
 * `copilot-vision-request: true` header before it accepts OpenAI-style
 * `image_url` content parts; without it images are silently dropped or
 * rejected.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
 */

export const setVisionHeader = rewriteHeaders('openaiChatCompletions', 'setVisionHeader', (payload, headers) =>
  payload.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
    ? setHeader(headers, 'copilot-vision-request', 'true')
    : headers);
