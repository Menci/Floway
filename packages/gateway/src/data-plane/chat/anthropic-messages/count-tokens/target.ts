import type { Counted } from './facts.ts';
import type { ChatNarrowing } from '../../resolve-candidates.ts';
import { chatTargetPicker } from '../../shared/target-picker.ts';
import { analyzeAnthropicMessagesAffinity } from '../affinity/ingress.ts';

/** Counting has no translation path: only an upstream's own Anthropic Messages endpoint can answer the
 *  question, so a candidate that would serve generation over a translated wire cannot serve
 *  this. */
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages']);

export const narrowing: ChatNarrowing<Counted<'response.chat.anthropicMessages'>, 'request.chat.anthropicMessages'> = ({
  requestKey: 'request.chat.anthropicMessages',
  canServe: candidate => anthropicMessagesCountTokensTarget.canServe(candidate.model.endpoints),
  affinity: async (payload, gateway) => await analyzeAnthropicMessagesAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /messages/count_tokens endpoint.`,
  refuse: (status, message) => ({ 'response.chat.anthropicMessages': { status, message } }),
  refuses: ['response.chat.anthropicMessages'],
});
