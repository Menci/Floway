import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/** `/v1/chat/completions` prefers its own wire, then the translated Anthropic Messages path,
 *  then the translated OpenAI Responses path. */
export const openaiChatCompletionsTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
export const narrowing = (payload: OpenAIChatCompletionsPayload): ChatNarrowing<Fields<'response.chat.openaiChatCompletions' | 'response.chat.openaiChatCompletions.streamedUsage'>> => ({
  canServe: candidate => openaiChatCompletionsTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeOpenAIChatCompletionsAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /chat/completions endpoint.`,
  refuse: (status, message, reason) => ({
    'response.chat.openaiChatCompletions.streamedUsage': null,
    'response.chat.openaiChatCompletions': {
      status,
      message,
      // What an OpenAI client reads: the condition's own type, and for a turn whose carried
      // state cannot be routed, the field at fault and the code that names it.
      envelope: {
        error: {
          message,
          type: 'invalid_request_error',
          ...(reason === 'routing-unavailable' ? { param: 'input', code: 'responses_item_routing_unavailable' } : {}),
        },
      },
    },
  }),
  refuses: ['response.chat.openaiChatCompletions', 'response.chat.openaiChatCompletions.streamedUsage'],
});
