import { composeTranslation } from '../composition.ts';
import { geminiGenerateContentSourceProtocol } from './source.ts';
import { anthropicMessagesTargetProtocol } from '../anthropic-messages/target.ts';
import { openaiChatCompletionsTargetProtocol } from '../openai-chat-completions/target.ts';
import { openaiResponsesTargetProtocol } from '../openai-responses/target.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

/**
 * A GenerateContent request, and the protocols it can be translated into.
 *
 * This file is the outermost boilerplate: it pairs a source with a target and
 * nothing else, because each side states only its own protocol.
 */
const viaAnthropicMessages = composeTranslation(geminiGenerateContentSourceProtocol, anthropicMessagesTargetProtocol);
const viaOpenAIChatCompletions = composeTranslation(geminiGenerateContentSourceProtocol, openaiChatCompletionsTargetProtocol);
const viaOpenAIResponses = composeTranslation(geminiGenerateContentSourceProtocol, openaiResponsesTargetProtocol);

export const routeGeminiGenerateContent = (input: GeminiGenerateContentPayload) => ({
  viaAnthropicMessages: (ctx: Parameters<typeof viaAnthropicMessages>[1]) => viaAnthropicMessages(input, ctx),
  viaOpenAIChatCompletions: (ctx: Parameters<typeof viaOpenAIChatCompletions>[1]) => viaOpenAIChatCompletions(input, ctx),
  viaOpenAIResponses: (ctx: Parameters<typeof viaOpenAIResponses>[1]) => viaOpenAIResponses(input, ctx),
});
