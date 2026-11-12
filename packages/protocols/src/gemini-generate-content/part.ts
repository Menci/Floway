import type { GeminiGenerateContentPart, GeminiGenerateContentPartData } from './index.ts';

export type GeminiGenerateContentPartKind = 'text' | 'inline_data' | 'function_call' | 'function_response' | 'file_data' | 'executable_code' | 'code_execution_result' | 'tool_call' | 'tool_response';

type GeminiGenerateContentPartDataField = keyof GeminiGenerateContentPartData;

// Source of truth for "what counts as a content-bearing field on a part".
// Record<GeminiGenerateContentPartDataField, _> forces a matching entry whenever a new field
// is added to GeminiGenerateContentPart, so Part readers cannot silently start
// dropping it.
const GEMINI_GENERATE_CONTENT_PART_FIELD_TO_KIND: Record<GeminiGenerateContentPartDataField, GeminiGenerateContentPartKind> = {
  text: 'text',
  inlineData: 'inline_data',
  functionCall: 'function_call',
  functionResponse: 'function_response',
  fileData: 'file_data',
  executableCode: 'executable_code',
  codeExecutionResult: 'code_execution_result',
  toolCall: 'tool_call',
  toolResponse: 'tool_response',
};

const GEMINI_GENERATE_CONTENT_PART_DATA_FIELDS = Object.keys(GEMINI_GENERATE_CONTENT_PART_FIELD_TO_KIND) as GeminiGenerateContentPartDataField[];

// Classify the part by its single content-bearing field. Returns null when
// the part only carries a thoughtSignature (a valid signature carrier with
// no body). Throws when the part sets zero or multiple content fields —
// both are silent-data-loss shapes the Part readers must refuse
// rather than coerce.
export const geminiGenerateContentPartKind = (part: GeminiGenerateContentPart): GeminiGenerateContentPartKind | null => {
  const presentFields = GEMINI_GENERATE_CONTENT_PART_DATA_FIELDS.filter(field => part[field] !== undefined);
  if (presentFields.length === 1) return GEMINI_GENERATE_CONTENT_PART_FIELD_TO_KIND[presentFields[0]];
  if (presentFields.length > 1) {
    throw new Error(`Gemini generateContent part sets conflicting content fields: ${presentFields.join(', ')}.`);
  }
  if (part.thoughtSignature !== undefined) return null;
  const keys = Object.keys(part);
  throw new Error(`Gemini generateContent part has no recognized content. Keys present: ${keys.length ? keys.join(', ') : '(none)'}.`);
};
