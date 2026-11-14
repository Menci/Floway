import { composeChat as compose } from '../compose.ts';
import type { ChatServices } from '../services.ts';
import type { ChatWire } from '../wire.ts';
import { decryptNativeCompaction } from './compact-decrypt.ts';
import { containsCompactionTrigger } from './compact-shim.ts';
import { inputErrorEnvelope } from './errors.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE } from './facts.ts';
import { openaiResponsesWire } from './wire.ts';
import { anthropicMessagesWire } from '../anthropic-messages/wire.ts';
import { handOff } from '../handoff.ts';
import { openaiChatCompletionsWire } from '../openai-chat-completions/wire.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import type { Use } from '@floway-dev/pipeline';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

/** The three wires `/v1/responses` can be served on. Its own is the bare wire; each translated
 *  one is a handoff and then the target protocol's own wire. */
export const openaiResponsesWireFor = (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  switch (target) {
  case 'openaiResponses':
  {
    const native = compose<Record<string, unknown>, Record<string, unknown>>('openaiResponsesNative', openaiResponsesWire(OPENAI_RESPONSES_STREAMED_USAGE));
    return compose('openaiResponsesNativeCompaction', [decryptNativeCompaction({ native, replay: native, streamedUsage: OPENAI_RESPONSES_STREAMED_USAGE, compactEndpoint: false, asked: payload => containsCompactionTrigger(payload.input) })]);
  }
  case 'anthropicMessages':
    return compose('openaiResponsesViaAnthropicMessages', [
      handOff({
        from: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        trip: async payload => await routeOpenAIResponsesViaAnthropicMessages(payload, {
          sidecarCodec: use.gateway.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
          fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
        }),
        refuseInput: inputErrorEnvelope,
      }),
      ...anthropicMessagesWire(OPENAI_RESPONSES_STREAMED_USAGE),
    ]);
  case 'openaiChatCompletions':
    return compose('openaiResponsesViaOpenAIChatCompletions', [
      handOff({
        from: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        trip: async payload => await routeOpenAIResponsesViaOpenAIChatCompletions(payload, { sidecarCodec: use.gateway.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
        refuseInput: inputErrorEnvelope,
      }),
      ...openaiChatCompletionsWire(OPENAI_RESPONSES_STREAMED_USAGE),
    ]);
  }
};
