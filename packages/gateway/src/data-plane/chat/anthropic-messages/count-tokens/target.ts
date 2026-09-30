import type { Counted } from './facts.ts';
import type { ChatNarrowing } from '../../resolve-candidates.ts';
import { chatTargetPicker } from '../../shared/target-picker.ts';
import { analyzeAnthropicMessagesAffinity } from '../affinity/ingress.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

/** Counting has no translation path: only an upstream's own Anthropic Messages endpoint can answer the
 *  question, so a candidate that would serve generation over a translated wire cannot serve
 *  this. */
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages']);

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
export const narrowing = (payload: AnthropicMessagesPayload): ChatNarrowing<Counted<'response.chat.anthropicMessages'>> => ({
  canServe: candidate => anthropicMessagesCountTokensTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeAnthropicMessagesAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /messages/count_tokens endpoint.`,
  refuse: (status, message) => ({ 'response.chat.anthropicMessages': { status, message } }),
  refuses: ['response.chat.anthropicMessages'],
});
