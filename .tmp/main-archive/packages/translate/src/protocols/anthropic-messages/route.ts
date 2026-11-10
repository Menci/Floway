import { translate as viaOpenAIChatCompletions } from './via-openai-chat-completions/translate.ts';
import { translate as viaOpenAIResponses } from './via-openai-responses/translate.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const routeAnthropicMessages = (input: AnthropicMessagesPayload) => ({
  viaOpenAIChatCompletions: (ctx: Parameters<typeof viaOpenAIChatCompletions>[1]) => viaOpenAIChatCompletions(input, ctx),
  viaOpenAIResponses: (ctx: Parameters<typeof viaOpenAIResponses>[1]) => viaOpenAIResponses(input, ctx),
});
