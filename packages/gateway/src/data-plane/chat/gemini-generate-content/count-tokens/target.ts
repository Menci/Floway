import type { Counted } from './facts.ts';
import type { ChatNarrowing } from '../../resolve-candidates.ts';
import { chatTargetPicker } from '../../shared/target-picker.ts';
import { analyzeGeminiGenerateContentAffinity } from '../affinity/ingress.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

/** Counting is reachable only over an upstream's own Anthropic Messages endpoint: no other protocol
 *  answers the question, and no translation invents an answer. */
export const geminiGenerateContentCountTokensTarget = chatTargetPicker(['anthropicMessages']);

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
export const narrowing = (payload: GeminiGenerateContentPayload): ChatNarrowing<Counted<'response.chat.geminiGenerateContent'>> => ({
  canServe: candidate => geminiGenerateContentCountTokensTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeGeminiGenerateContentAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support countTokens.`,
  refuse: (status, message) => ({ 'response.chat.geminiGenerateContent': { status, message } }),
  refuses: ['response.chat.geminiGenerateContent'],
});
