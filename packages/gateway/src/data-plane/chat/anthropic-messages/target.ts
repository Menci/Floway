import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeAnthropicMessagesAffinity } from './affinity/ingress.ts';

/** `/v1/messages` prefers its own wire, then the translated OpenAI Responses path, then the
 *  translated OpenAI Chat Completions path. */
export const anthropicMessagesTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']);

export const narrowing: ChatNarrowing<Fields<'response.chat.anthropicMessages' | 'response.chat.anthropicMessages.streamedUsage'>, 'request.chat.anthropicMessages'> = ({
  requestKey: 'request.chat.anthropicMessages',
  canServe: candidate => anthropicMessagesTarget.canServe(candidate.model.endpoints),
  affinity: async (payload, gateway) => await analyzeAnthropicMessagesAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /messages endpoint.`,
  refuse: (status, message) => ({
    'response.chat.anthropicMessages': { status, message },
    // A refusal never opened a stream, so there is nothing still to read — which is what
    // lets settlement write its row here rather than wait for numbers that never come.
    'response.chat.anthropicMessages.streamedUsage': null,
  }),
  refuses: ['response.chat.anthropicMessages', 'response.chat.anthropicMessages.streamedUsage'],
});
