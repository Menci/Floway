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
export const copilotOpenAIChatCompletionsHasImage = (payload: OpenAIChatCompletionsPayloadEx): boolean =>
  payload.messages.some(
    message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'),
  );
