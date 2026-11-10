import { anthropicMessagesSourceProtocol } from '../../src/protocols/anthropic-messages/as-source.ts';
import { anthropicMessagesTargetProtocol } from '../../src/protocols/anthropic-messages/as-target.ts';
import { buildTargetPayloadFor, buildSourceEventsFor } from '../../src/protocols/composition.ts';
import { geminiGenerateContentSourceProtocol } from '../../src/protocols/gemini-generate-content/as-source.ts';
import { openaiChatCompletionsSourceProtocol } from '../../src/protocols/openai-chat-completions/as-source.ts';
import { openaiChatCompletionsTargetProtocol } from '../../src/protocols/openai-chat-completions/as-target.ts';
import { openaiResponsesSourceProtocol } from '../../src/protocols/openai-responses/as-source.ts';
import { openaiResponsesTargetProtocol } from '../../src/protocols/openai-responses/as-target.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

/**
 * The protocols a returned stream can be stated to, paired with the source it
 * starts from. Each entry is one composed pair, so a test names the pair it
 * exercises rather than restating the wiring.
 */
export const pairs = {
  messagesToChat: [anthropicMessagesSourceProtocol, openaiChatCompletionsTargetProtocol],
  messagesToResponses: [anthropicMessagesSourceProtocol, openaiResponsesTargetProtocol],
  chatToMessages: [openaiChatCompletionsSourceProtocol, anthropicMessagesTargetProtocol],
  chatToResponses: [openaiChatCompletionsSourceProtocol, openaiResponsesTargetProtocol],
  responsesToMessages: [openaiResponsesSourceProtocol, anthropicMessagesTargetProtocol],
  responsesToChat: [openaiResponsesSourceProtocol, openaiChatCompletionsTargetProtocol],
  geminiToMessages: [geminiGenerateContentSourceProtocol, anthropicMessagesTargetProtocol],
  geminiToChat: [geminiGenerateContentSourceProtocol, openaiChatCompletionsTargetProtocol],
  geminiToResponses: [geminiGenerateContentSourceProtocol, openaiResponsesTargetProtocol],
} as const;

/** A request that states nothing, which reading a returned stream only needs to exist. */
export const emptyPayload = {
  messages: { model: 'm', max_tokens: 16, stream: true, messages: [] } as AnthropicMessagesPayload,
  chat: { model: 'm', stream: true, messages: [] } as OpenAIChatCompletionsPayloadEx,
  responses: { model: 'm', stream: true, input: [] } as OpenAIResponsesRequestPayloadEx,
  gemini: { model: 'model', contents: [] } as GeminiGenerateContentRequest,
};

export { buildTargetPayloadFor, buildSourceEventsFor };
