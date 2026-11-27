import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule, JSONRule } from '../../../round-trip/reference/types.ts';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

type GeminiPartRule = {
  text: TextRule;
  inlineData: { data: TextRule };
  audioTranscription: { text: TextRule };
  functionCall: { args: JSONRule };
};

export type GeminiGenerateContentInputAssistantTurn = Array<Omit<GeminiGenerateContentContent, 'role'> & { role: 'model' }>;
export type GeminiGenerateContentReferenceableInputAssistantTurn<Reference> = ReferenceableValue<GeminiGenerateContentInputAssistantTurn, [{ parts: [GeminiPartRule] }], Reference>;
export type GeminiGenerateContentInputAssistantTurnState<States extends ReferenceStateLeaves> = ReferenceState<GeminiGenerateContentInputAssistantTurn, [{ parts: [GeminiPartRule] }], States>;
