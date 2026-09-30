import { composeChat as compose } from '../compose.ts';
import type { ChatWire } from '../wire.ts';
import { STREAMED_USAGE } from './facts.ts';
import { anthropicMessagesWire } from './wire.ts';
import { handOff } from '../handoff.ts';
import { openaiChatCompletionsWire } from '../openai-chat-completions/wire.ts';
import { projectOpenAIResponsesCollaboration } from '../openai-responses/collaboration-shim.ts';
import { openaiResponsesWire } from '../openai-responses/wire.ts';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { translateAnthropicMessagesViaOpenAIResponses, translateAnthropicMessagesViaOpenAIChatCompletions } from '@floway-dev/translate';

/** The three wires `/v1/messages` can be served on. Its own is the bare wire; each translated
 *  one is a handoff and then the target protocol's own wire. */
export const anthropicMessagesWireFor = (target: ChatTargetApi, candidate: ModelCandidate): ChatWire => {
  switch (target) {
  case 'anthropicMessages':
    return compose('anthropicMessagesNative', anthropicMessagesWire(STREAMED_USAGE));
  case 'openaiResponses':
    return compose('anthropicMessagesViaOpenAIResponses', [
      handOff({
        from: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        to: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        trip: async payload => await translateAnthropicMessagesViaOpenAIResponses(payload, { model: candidate.model.id }),
      }),
      projectOpenAIResponsesCollaboration,
      ...openaiResponsesWire(STREAMED_USAGE),
    ]);
  case 'openaiChatCompletions':
    return compose('anthropicMessagesViaOpenAIChatCompletions', [
      handOff({
        from: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        trip: async payload => await translateAnthropicMessagesViaOpenAIChatCompletions(payload, { model: candidate.model.id }),
      }),
      ...openaiChatCompletionsWire(STREAMED_USAGE),
    ]);
  }
};
