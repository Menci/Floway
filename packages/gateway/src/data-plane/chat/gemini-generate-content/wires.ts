import { composeChat as compose } from '../compose.ts';
import { handOff } from '../handoff.ts';
import { STREAMED_USAGE } from './facts.ts';
import { anthropicMessagesWire } from '../anthropic-messages/wire.ts';
import { openaiChatCompletionsWire } from '../openai-chat-completions/wire.ts';
import { projectOpenAIResponsesCollaboration } from '../openai-responses/collaboration-shim.ts';
import { openaiResponsesWire } from '../openai-responses/wire.ts';
import type { ChatWire } from '../wire.ts';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { translateGeminiGenerateContentViaOpenAIChatCompletions, translateGeminiGenerateContentViaAnthropicMessages, translateGeminiGenerateContentViaOpenAIResponses } from '@floway-dev/translate';

/** The three wires `:generateContent` can be served on, and all three are translated ones:
 *  the provider surface has no Gemini generateContent call, so a handoff is how every candidate is reached. */
export const geminiGenerateContentWireFor = (target: ChatTargetApi, candidate: ModelCandidate): ChatWire => {
  const context = { model: candidate.model.id, fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens };
  switch (target) {
  case 'openaiChatCompletions':
    return compose('geminiGenerateContentViaOpenAIChatCompletions', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        trip: async payload => await translateGeminiGenerateContentViaOpenAIChatCompletions(payload, context),
      }),
      ...openaiChatCompletionsWire(STREAMED_USAGE),
    ]);
  case 'anthropicMessages':
    return compose('geminiGenerateContentViaAnthropicMessages', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        trip: async payload => await translateGeminiGenerateContentViaAnthropicMessages(payload, context),
      }),
      ...anthropicMessagesWire(STREAMED_USAGE),
    ]);
  case 'openaiResponses':
    return compose('geminiGenerateContentViaOpenAIResponses', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        trip: async payload => await translateGeminiGenerateContentViaOpenAIResponses(payload, context),
      }),
      projectOpenAIResponsesCollaboration,
      ...openaiResponsesWire(STREAMED_USAGE),
    ]);
  }
};
