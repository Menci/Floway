import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';

/** `/v1/chat/completions` prefers its own wire, then the translated Anthropic Messages path,
 *  then the translated OpenAI Responses path. */
export const openaiChatCompletionsTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);

export const narrowing: ChatNarrowing<Fields<'response.chat.openaiChatCompletions' | 'response.chat.openaiChatCompletions.streamedUsage'>, 'request.chat.openaiChatCompletions'> = ({
  requestKey: 'request.chat.openaiChatCompletions',
  canServe: candidate => openaiChatCompletionsTarget.canServe(candidate.model.endpoints),
  affinity: async (payload, gateway) => await analyzeOpenAIChatCompletionsAffinity(payload, gateway.affinity.codec),
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
