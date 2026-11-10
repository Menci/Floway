import { translate as viaAnthropicMessages } from './via-anthropic-messages/translate.ts';
import { translate as viaOpenAIChatCompletions } from './via-openai-chat-completions/translate.ts';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

export const routeOpenAIResponses = (input: OpenAIResponsesRequestPayloadEx) => ({
  viaAnthropicMessages: (ctx: Parameters<typeof viaAnthropicMessages>[1]) => viaAnthropicMessages(input, ctx),
  viaOpenAIChatCompletions: (ctx: Parameters<typeof viaOpenAIChatCompletions>[1]) => viaOpenAIChatCompletions(input, ctx),
});
