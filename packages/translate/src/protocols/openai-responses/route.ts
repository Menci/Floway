import { composeTranslation } from '../composition.ts';
import { openaiResponsesSourceProtocol } from './source.ts';
import { anthropicMessagesTargetProtocol } from '../anthropic-messages/target.ts';
import { openaiChatCompletionsTargetProtocol } from '../openai-chat-completions/target.ts';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

/**
 * An OpenAI Responses request, and the protocols it can be translated into.
 *
 * This file is the outermost boilerplate: it pairs a source with a target and
 * nothing else, because each side states only its own protocol.
 */
const viaAnthropicMessages = composeTranslation(openaiResponsesSourceProtocol, anthropicMessagesTargetProtocol);
const viaOpenAIChatCompletions = composeTranslation(openaiResponsesSourceProtocol, openaiChatCompletionsTargetProtocol);

export const routeOpenAIResponses = (input: OpenAIResponsesRequestPayloadEx) => ({
  viaAnthropicMessages: (ctx: Parameters<typeof viaAnthropicMessages>[1]) => viaAnthropicMessages(input, ctx),
  viaOpenAIChatCompletions: (ctx: Parameters<typeof viaOpenAIChatCompletions>[1]) => viaOpenAIChatCompletions(input, ctx),
});
