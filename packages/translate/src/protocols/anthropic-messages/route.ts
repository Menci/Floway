import { composeTranslation } from '../composition.ts';
import { anthropicMessagesSourceProtocol } from './source.ts';
import { openaiChatCompletionsTargetProtocol } from '../openai-chat-completions/target.ts';
import { openaiResponsesTargetProtocol } from '../openai-responses/target.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

/**
 * A Messages request, and the protocols it can be translated into.
 *
 * This file is the outermost boilerplate: it pairs a source with a target and
 * nothing else, because each side states only its own protocol. Each trip is
 * created once and reused, since composing it does no per-request work.
 */
const viaOpenAIChatCompletions = composeTranslation(anthropicMessagesSourceProtocol, openaiChatCompletionsTargetProtocol);
const viaOpenAIResponses = composeTranslation(anthropicMessagesSourceProtocol, openaiResponsesTargetProtocol);

export const routeAnthropicMessages = (input: AnthropicMessagesPayload) => ({
  viaOpenAIChatCompletions: (ctx: Parameters<typeof viaOpenAIChatCompletions>[1]) => viaOpenAIChatCompletions(input, ctx),
  viaOpenAIResponses: (ctx: Parameters<typeof viaOpenAIResponses>[1]) => viaOpenAIResponses(input, ctx),
});
