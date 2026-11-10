import type { GeminiGenerateContentPartData, GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

const GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

// OpenAI Chat Completions accepts only WAV and MP3 input audio.
// https://github.com/openai/openai-node/blob/3f8753e0fc60f22c10c925b391810f45c3904af8/src/resources/chat/completions/completions.ts#L1591-L1621
const GEMINI_GENERATE_CONTENT_AUDIO_FORMATS = {
  'audio/wav': 'wav',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
} as const;

export type GeminiGenerateContentSupportedImageMimeType = (typeof GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES)[number];

export type GeminiGenerateContentInlineData =
  | { kind: 'image'; mimeType: GeminiGenerateContentSupportedImageMimeType; data: string }
  | { kind: 'pdf'; mimeType: 'application/pdf'; data: string }
  | { kind: 'audio'; mimeType: keyof typeof GEMINI_GENERATE_CONTENT_AUDIO_FORMATS; format: (typeof GEMINI_GENERATE_CONTENT_AUDIO_FORMATS)[keyof typeof GEMINI_GENERATE_CONTENT_AUDIO_FORMATS]; data: string }
  | { kind: 'unsupported'; mimeType: string; data: string };

export type GeminiGenerateContentPartKind = 'text' | 'inline_data' | 'function_call' | 'function_response' | 'file_data' | 'executable_code' | 'code_execution_result' | 'tool_call' | 'tool_response';

type GeminiGenerateContentPartDataField = keyof GeminiGenerateContentPartData;

// Source of truth for "what counts as a content-bearing field on a part".
// Record<GeminiGenerateContentPartDataField, _> forces a matching entry whenever a new field
// is added to GeminiGenerateContentPart, so request translators cannot silently start
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
// both are silent-data-loss shapes the request translators must refuse
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

export const geminiGenerateContentPartText = (part: GeminiGenerateContentPart): string | null => (typeof part.text === 'string' ? part.text : null);

export const geminiGenerateContentThoughtText = (part: GeminiGenerateContentPart): string | null => (part.thought === true && typeof part.text === 'string' ? part.text : null);

export const geminiGenerateContentVisibleText = (part: GeminiGenerateContentPart): string | null => (part.thought === true ? null : geminiGenerateContentPartText(part));

export const geminiGenerateContentText = (content?: GeminiGenerateContentContent): string | null => {
  const texts = content?.parts?.map(geminiGenerateContentPartText).filter((text): text is string => text !== null);

  return texts?.length ? texts.join('\n\n') : null;
};

export const geminiGenerateContentInlineData = (part: GeminiGenerateContentPart): GeminiGenerateContentInlineData | null => {
  const inlineData = part.inlineData;
  if (!inlineData) return null;

  if (GEMINI_GENERATE_CONTENT_SUPPORTED_IMAGE_MIME_TYPES.includes(inlineData.mimeType as GeminiGenerateContentSupportedImageMimeType)) {
    return {
      kind: 'image',
      mimeType: inlineData.mimeType as GeminiGenerateContentSupportedImageMimeType,
      data: inlineData.data,
    };
  }

  if (inlineData.mimeType === 'application/pdf') {
    return { kind: 'pdf', mimeType: inlineData.mimeType, data: inlineData.data };
  }

  const audioFormat = GEMINI_GENERATE_CONTENT_AUDIO_FORMATS[inlineData.mimeType as keyof typeof GEMINI_GENERATE_CONTENT_AUDIO_FORMATS];
  if (audioFormat !== undefined) {
    return {
      kind: 'audio',
      mimeType: inlineData.mimeType as keyof typeof GEMINI_GENERATE_CONTENT_AUDIO_FORMATS,
      format: audioFormat,
      data: inlineData.data,
    };
  }

  return {
    kind: 'unsupported',
    mimeType: inlineData.mimeType,
    data: inlineData.data,
  };
};
