import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeOpenAIResponsesAffinity } from './affinity/ingress.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/** `/v1/responses` prefers its own wire, then the translated Anthropic Messages path, then
 *  the translated OpenAI Chat Completions path. */
export const openaiResponsesTarget = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);

export const openaiResponsesNarrowing: ChatNarrowing<Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage'>, 'request.chat.openaiResponses'> = ({
  requestKey: 'request.chat.openaiResponses',
  canServe: candidate => openaiResponsesTarget.canServe(candidate.model.endpoints),
  affinity: async (payload, gateway) => await analyzeOpenAIResponsesAffinity(payload as CanonicalOpenAIResponsesPayload, gateway.affinity.codec),
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
