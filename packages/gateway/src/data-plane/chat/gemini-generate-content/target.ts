import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeGeminiGenerateContentAffinity } from './affinity/ingress.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

/** `:generateContent` has no wire of its own, so the whole preference list is translated:
 *  OpenAI Chat Completions first, then Anthropic Messages, then OpenAI Responses. */
export const geminiGenerateContentTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
export const narrowing = (payload: GeminiGenerateContentPayload): ChatNarrowing<Fields<'response.chat.geminiGenerateContent' | 'response.chat.geminiGenerateContent.streamedUsage'>> => ({
  canServe: candidate => geminiGenerateContentTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeGeminiGenerateContentAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the Gemini generateContent endpoint.`,
  refuse: (status, message) => ({
    'response.chat.geminiGenerateContent': { status, message },
    // A refusal never opened a stream, so there is nothing still to read — which is what
    // lets settlement write its row here rather than wait for numbers that never come.
    'response.chat.geminiGenerateContent.streamedUsage': null,
  }),
  refuses: ['response.chat.geminiGenerateContent', 'response.chat.geminiGenerateContent.streamedUsage'],
});
