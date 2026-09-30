import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeAnthropicMessagesAffinity } from './affinity/ingress.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

/** `/v1/messages` prefers its own wire, then the translated OpenAI Responses path, then the
 *  translated OpenAI Chat Completions path. */
export const anthropicMessagesTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']);

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
export const narrowing = (payload: AnthropicMessagesPayload): ChatNarrowing<Fields<'response.chat.anthropicMessages' | 'response.chat.anthropicMessages.streamedUsage'>> => ({
  canServe: candidate => anthropicMessagesTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeAnthropicMessagesAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /messages endpoint.`,
  refuse: (status, message) => ({
    'response.chat.anthropicMessages': { status, message },
    // A refusal never opened a stream, so there is nothing still to read — which is what
    // lets settlement write its row here rather than wait for numbers that never come.
    'response.chat.anthropicMessages.streamedUsage': null,
  }),
  refuses: ['response.chat.anthropicMessages', 'response.chat.anthropicMessages.streamedUsage'],
});
