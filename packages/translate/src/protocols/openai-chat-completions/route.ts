import { composeTranslation } from '../composition.ts';
import { openaiChatCompletionsSourceProtocol } from './source.ts';
import { anthropicMessagesTargetProtocol } from '../anthropic-messages/target.ts';
import { openaiResponsesTargetProtocol } from '../openai-responses/target.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

/**
 * A Chat Completions request, and the protocols it can be translated into.
 *
 * This file is the outermost boilerplate: it pairs a source with a target and
 * nothing else, because each side states only its own protocol.
 */
const viaAnthropicMessages = composeTranslation(openaiChatCompletionsSourceProtocol, anthropicMessagesTargetProtocol);
const viaOpenAIResponses = composeTranslation(openaiChatCompletionsSourceProtocol, openaiResponsesTargetProtocol);

export const routeOpenAIChatCompletions = (input: OpenAIChatCompletionsPayloadEx) => ({
  viaAnthropicMessages: (ctx: Parameters<typeof viaAnthropicMessages>[1]) => viaAnthropicMessages(input, ctx),
  viaOpenAIResponses: (ctx: Parameters<typeof viaOpenAIResponses>[1]) => viaOpenAIResponses(input, ctx),
});
