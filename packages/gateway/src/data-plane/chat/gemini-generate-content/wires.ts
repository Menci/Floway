import { composeChat as compose } from '../compose.ts';
import { handOff } from '../handoff.ts';
import { mintGeminiGenerateContentInputFailure } from './errors.ts';
import { STREAMED_USAGE } from './facts.ts';
import { anthropicMessagesWire } from '../anthropic-messages/wire.ts';
import { openaiChatCompletionsWire } from '../openai-chat-completions/wire.ts';
import { projectOpenAIResponsesCollaboration } from '../openai-responses/collaboration-shim.ts';
import { openaiResponsesWire } from '../openai-responses/wire.ts';
import type { ChatServices } from '../services.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import type { ChatWire } from '../wire.ts';
import type { Use } from '@floway-dev/pipeline';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { routeGeminiGenerateContentViaOpenAIChatCompletions, routeGeminiGenerateContentViaAnthropicMessages, routeGeminiGenerateContentViaOpenAIResponses, type TranslateInputError } from '@floway-dev/translate';

/** The three wires `:generateContent` can be served on, and all three are translated ones:
 *  the provider surface has no Gemini generateContent call, so a handoff is how every candidate is reached. */
export const geminiGenerateContentWireFor = (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  const context = { sidecarCodec: use.gateway.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn), fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens };
  const refuseInput = (error: TranslateInputError) => mintGeminiGenerateContentInputFailure(error).body as unknown as Record<string, unknown>;
  switch (target) {
  case 'openaiChatCompletions':
    return compose('geminiGenerateContentViaOpenAIChatCompletions', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        trip: async payload => await routeGeminiGenerateContentViaOpenAIChatCompletions({ ...payload, model: candidate.model.id }, context),
        refuseInput,
      }),
      ...openaiChatCompletionsWire(STREAMED_USAGE),
    ]);
  case 'anthropicMessages':
    return compose('geminiGenerateContentViaAnthropicMessages', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        trip: async payload => await routeGeminiGenerateContentViaAnthropicMessages({ ...payload, model: candidate.model.id }, context),
        refuseInput,
      }),
      ...anthropicMessagesWire(STREAMED_USAGE),
    ]);
  case 'openaiResponses':
    return compose('geminiGenerateContentViaOpenAIResponses', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        trip: async payload => await routeGeminiGenerateContentViaOpenAIResponses({ ...payload, model: candidate.model.id }, context),
        refuseInput,
      }),
      projectOpenAIResponsesCollaboration,
      ...openaiResponsesWire(STREAMED_USAGE),
    ]);
  }
};
