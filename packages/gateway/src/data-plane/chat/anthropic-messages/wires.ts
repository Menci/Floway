import { composeChat as compose } from '../compose.ts';
import type { ChatWire } from '../wire.ts';
import { anthropicMessagesInputError } from './errors.ts';
import { STREAMED_USAGE } from './facts.ts';
import { anthropicMessagesWire } from './wire.ts';
import { handOff } from '../handoff.ts';
import { openaiChatCompletionsWire } from '../openai-chat-completions/wire.ts';
import { projectOpenAIResponsesCollaboration } from '../openai-responses/collaboration-shim.ts';
import { openaiResponsesWire } from '../openai-responses/wire.ts';
import type { ChatServices } from '../services.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import type { Use } from '@floway-dev/pipeline';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { routeAnthropicMessagesViaOpenAIResponses, routeAnthropicMessagesViaOpenAIChatCompletions } from '@floway-dev/translate';

/** The three wires `/v1/messages` can be served on. Its own is the bare wire; each translated
 *  one is a handoff and then the target protocol's own wire. */
export const anthropicMessagesWireFor = (target: ChatTargetApi, _candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  switch (target) {
  case 'anthropicMessages':
    return compose('anthropicMessagesNative', anthropicMessagesWire(STREAMED_USAGE));
  case 'openaiResponses':
    return compose('anthropicMessagesViaOpenAIResponses', [
      handOff({
        from: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        to: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        trip: async payload => await routeAnthropicMessagesViaOpenAIResponses(payload, { sidecarCodec: use.gateway.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
        refuseInput: anthropicMessagesInputError,
      }),
      projectOpenAIResponsesCollaboration,
      ...openaiResponsesWire(STREAMED_USAGE),
    ]);
  case 'openaiChatCompletions':
    return compose('anthropicMessagesViaOpenAIChatCompletions', [
      handOff({
        from: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        trip: async payload => await routeAnthropicMessagesViaOpenAIChatCompletions(payload, { sidecarCodec: use.gateway.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
        refuseInput: anthropicMessagesInputError,
      }),
      ...openaiChatCompletionsWire(STREAMED_USAGE),
    ]);
  }
};
