import type { ChatNarrowing } from '../resolve-candidates.ts';
import type { Fields } from './facts.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { analyzeGeminiGenerateContentAffinity } from './affinity/ingress.ts';

/** `:generateContent` has no wire of its own, so the whole preference list is translated:
 *  OpenAI Chat Completions first, then Anthropic Messages, then OpenAI Responses. */
export const geminiGenerateContentTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);

export const narrowing: ChatNarrowing<Fields<'response.chat.geminiGenerateContent' | 'response.chat.geminiGenerateContent.streamedUsage'>, 'request.chat.geminiGenerateContent'> = ({
  requestKey: 'request.chat.geminiGenerateContent',
  canServe: candidate => geminiGenerateContentTarget.canServe(candidate.model.endpoints),
  affinity: async (payload, gateway) => await analyzeGeminiGenerateContentAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the Gemini generateContent endpoint.`,
  refuse: (status, message) => ({
    'response.chat.geminiGenerateContent': { status, message },
    // A refusal never opened a stream, so there is nothing still to read — which is what
    // lets settlement write its row here rather than wait for numbers that never come.
    'response.chat.geminiGenerateContent.streamedUsage': null,
  }),
  refuses: ['response.chat.geminiGenerateContent', 'response.chat.geminiGenerateContent.streamedUsage'],
});
