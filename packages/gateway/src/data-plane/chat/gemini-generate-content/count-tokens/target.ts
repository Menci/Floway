import type { Counted } from './facts.ts';
import type { ChatNarrowing } from '../../resolve-candidates.ts';
import { chatTargetPicker } from '../../shared/target-picker.ts';
import { analyzeGeminiGenerateContentAffinity } from '../affinity/ingress.ts';

export const geminiGenerateContentCountTokensTarget = chatTargetPicker(['geminiGenerateContent', 'anthropicMessages']);

export const narrowing: ChatNarrowing<Counted<'response.chat.geminiGenerateContent'>, 'request.chat.geminiGenerateContent'> = ({
  requestKey: 'request.chat.geminiGenerateContent',
  canServe: candidate => geminiGenerateContentCountTokensTarget.canServe(candidate.model.endpoints),
  affinity: async (payload, gateway) => await analyzeGeminiGenerateContentAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support countTokens.`,
  refuse: (status, message) => ({ 'response.chat.geminiGenerateContent': { status, message } }),
  refuses: ['response.chat.geminiGenerateContent'],
});
