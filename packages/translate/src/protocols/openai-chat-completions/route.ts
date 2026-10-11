import { translate as viaAnthropicMessages } from './via-anthropic-messages/translate.ts';
import { translate as viaOpenAIResponses } from './via-openai-responses/translate.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const routeOpenAIChatCompletions = (input: OpenAIChatCompletionsPayload) => ({
  viaAnthropicMessages: (ctx: Parameters<typeof viaAnthropicMessages>[1]) => viaAnthropicMessages(input, ctx),
  viaOpenAIResponses: (ctx: Parameters<typeof viaOpenAIResponses>[1]) => viaOpenAIResponses(input, ctx),
});
