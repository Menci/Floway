import type { ThinValue, TextRule, JSONRule } from '../../../round-trip/thin/assistant-turn.ts';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

type GeminiPartRule = {
  text: TextRule;
  inlineData: { data: TextRule };
  audioTranscription: { text: TextRule };
  functionCall: { args: JSONRule };
};

export type GeminiGenerateContentThinAssistantTurn<Reference> = ThinValue<GeminiGenerateContentInputAssistantTurn, [{ parts: [GeminiPartRule] }], Reference>;

export type GeminiGenerateContentInputAssistantTurn = Array<Omit<GeminiGenerateContentContent, 'role'> & { role: 'model' }>;
