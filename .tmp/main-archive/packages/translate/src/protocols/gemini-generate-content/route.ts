import { translate as viaAnthropicMessages } from './via-anthropic-messages/translate.ts';
import { translate as viaOpenAIChatCompletions } from './via-openai-chat-completions/translate.ts';
import { translate as viaOpenAIResponses } from './via-openai-responses/translate.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

export const routeGeminiGenerateContent = (input: GeminiGenerateContentPayload) => ({
  viaAnthropicMessages: (ctx: Parameters<typeof viaAnthropicMessages>[1]) => viaAnthropicMessages(input, ctx),
  viaOpenAIChatCompletions: (ctx: Parameters<typeof viaOpenAIChatCompletions>[1]) => viaOpenAIChatCompletions(input, ctx),
  viaOpenAIResponses: (ctx: Parameters<typeof viaOpenAIResponses>[1]) => viaOpenAIResponses(input, ctx),
});
