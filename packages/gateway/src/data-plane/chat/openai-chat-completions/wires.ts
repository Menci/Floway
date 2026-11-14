import { composeChat as compose } from '../compose.ts';
import type { ChatWire } from '../wire.ts';
import { STREAMED_USAGE } from './facts.ts';
import { openaiChatCompletionsWire } from './wire.ts';
import { anthropicMessagesWire } from '../anthropic-messages/wire.ts';
import { handOff } from '../handoff.ts';
import { projectOpenAIResponsesCollaboration } from '../openai-responses/collaboration-shim.ts';
import { openaiResponsesWire } from '../openai-responses/wire.ts';
import type { ChatServices } from '../services.ts';
import { openaiChatCompletionsInputError } from './errors.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import type { Use } from '@floway-dev/pipeline';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { routeOpenAIChatCompletionsViaAnthropicMessages, routeOpenAIChatCompletionsViaOpenAIResponses } from '@floway-dev/translate';

/** The three wires `/v1/chat/completions` can be served on. Its own is the bare wire; each
 *  translated one is a handoff and then the target protocol's own wire. */
export const openaiChatCompletionsWireFor = (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  switch (target) {
  case 'openaiChatCompletions':
    return compose('openaiChatCompletionsNative', openaiChatCompletionsWire(STREAMED_USAGE));
  case 'anthropicMessages':
    return compose('openaiChatCompletionsViaAnthropicMessages', [
      handOff({
        from: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        trip: async payload => await routeOpenAIChatCompletionsViaAnthropicMessages(payload, {
          sidecarCodec: use.gateway.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
          fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
        }),
        refuseInput: openaiChatCompletionsInputError,
      }),
      ...anthropicMessagesWire(STREAMED_USAGE),
    ]);
  case 'openaiResponses':
    return compose('openaiChatCompletionsViaOpenAIResponses', [
      handOff({
        from: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        to: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        trip: async payload => await routeOpenAIChatCompletionsViaOpenAIResponses(payload, { sidecarCodec: use.gateway.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
        refuseInput: openaiChatCompletionsInputError,
      }),
      projectOpenAIResponsesCollaboration,
      ...openaiResponsesWire(STREAMED_USAGE),
    ]);
  }
};
