import { defineCopilotStage } from '../facts.ts';
import type { HttpHeaders } from '@floway-dev/http';
import { setHeader } from '@floway-dev/http';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Copilot's OpenAI Chat Completions endpoint requires the private
 * `copilot-vision-request: true` header before it accepts OpenAI-style
 * `image_url` content parts; without it images are silently dropped or
 * rejected.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
 */

const shapeSetVisionHeader = (payload: OpenAIChatCompletionsPayloadEx, headers: HttpHeaders): HttpHeaders =>
  payload.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
    ? setHeader(headers, 'copilot-vision-request', 'true')
    : headers;

export const setVisionHeader = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.setVisionHeader',
  through: {
    request: { needs: ['openaiChatCompletions', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiChatCompletions;
    const headers = shapeSetVisionHeader(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
