import type { IRJSONObject } from '../../../ir/common/json.ts';
import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule, JSONRule } from '../../../round-trip/reference/types.ts';
import type { ToolArgumentsEnvelope } from '../../../shared/tool-schema-envelope.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentFunctionCall, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

type GenerateContentPartRule = {
  text: TextRule;
  inlineData: { data: TextRule };
  audioTranscription: { text: TextRule };
};

type ReferenceableFunctionCallArgs<Reference> =
  | ReferenceableValue<NonNullable<GeminiGenerateContentFunctionCall['args']>, JSONRule, Reference>
  | ToolArgumentsEnvelope<ReferenceableValue<IRJSONObject, JSONRule, Reference>>;

type ReferenceableGenerateContentPart<Part, Reference> = Part extends { functionCall: GeminiGenerateContentFunctionCall }
  ? Omit<Part, 'functionCall'> & {
    functionCall: Omit<Part['functionCall'], 'args'> & { args?: ReferenceableFunctionCallArgs<Reference> };
  }
  : ReferenceableValue<Part, GenerateContentPartRule, Reference>;

type GenerateContentPartState<States extends ReferenceStateLeaves> =
  | ReferenceState<GeminiGenerateContentPart, GenerateContentPartRule, States>
  | { functionCall: { args: States['json'] | ToolArgumentsEnvelope<States['json']> } };

export type GeminiGenerateContentInputAssistantTurn = Array<
  Omit<GeminiGenerateContentContent, 'role' | 'parts'> & {
    role: 'model';
    parts: GeminiGenerateContentPart[];
  }
>;
export type GeminiGenerateContentReferenceableInputAssistantTurn<Reference> = Array<
  Omit<GeminiGenerateContentContent, 'role' | 'parts'> & {
    role: 'model';
    parts: ReferenceableGenerateContentPart<GeminiGenerateContentPart, Reference>[];
  }
>;
export type GeminiGenerateContentInputAssistantTurnState<States extends ReferenceStateLeaves> = Array<{
  parts?: Array<GenerateContentPartState<States> | undefined>;
}>;
