import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeOpenAIResponsesAffinity } from './affinity/ingress.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/** `/v1/responses` prefers its own wire, then the translated Anthropic Messages path, then
 *  the translated OpenAI Chat Completions path. */
export const openaiResponsesTarget = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant.
 *
 *  It reads the request through a function because the one it has to read is the *prepared*
 *  one: a `previous_response_id` continuation carries the prior turn's state on items the
 *  client never sent, and a turn is pinned by what its items carry. The narrowing is built
 *  at assembly, before any fact exists, so the membrane hands the prepared payload across
 *  through the run's own cell rather than through the record. */
export const openaiResponsesNarrowing = (prepared: () => CanonicalOpenAIResponsesPayload): ChatNarrowing<Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage'>> => ({
  canServe: candidate => openaiResponsesTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeOpenAIResponsesAffinity(prepared(), gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /responses endpoint.`,
  refuse: (status, message, reason) => ({
    'response.chat.openaiResponses.streamedUsage': null,
    'response.chat.openaiResponses': {
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
  refuses: ['response.chat.openaiResponses', 'response.chat.openaiResponses.streamedUsage'],
});
