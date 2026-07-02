import type { GeminiContent, GeminiFinishReason, GeminiFunctionCallingConfig, GeminiFunctionDeclaration, GeminiPayload, GeminiPart, GeminiStreamEvent, GeminiThinkingConfig, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';

const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export type GeminiToolCallIds = Record<string, string[]>;

export type GeminiFunctionCall = NonNullable<GeminiPart['functionCall']>;
export type GeminiFunctionResponse = NonNullable<GeminiPart['functionResponse']>;

export type GeminiFunctionCallingIntent = { type: 'none' } | { type: 'auto' } | { type: 'any' } | { type: 'named'; name: string };

export interface GeminiFunctionCallPart {
  call: GeminiFunctionCall;
  id: string;
}

export interface GeminiFunctionResponsePart {
  response: GeminiFunctionResponse;
  id: string;
}

const GEMINI_SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export type GeminiSupportedImageMimeType = (typeof GEMINI_SUPPORTED_IMAGE_MIME_TYPES)[number];

export const geminiToolCallId = (turnIndex: number, partIndex: number): string => `gemini_call_${turnIndex}_${partIndex}`;

export const geminiReasoningId = (turnIndex: number, partIndex: number): string => `gemini_reasoning_${turnIndex}_${partIndex}`;

export type GeminiPartKind = 'text' | 'inline_data' | 'function_call' | 'function_response' | 'file_data' | 'executable_code' | 'code_execution_result';

type GeminiPartDataField = keyof Omit<GeminiPart, 'thought' | 'thoughtSignature'>;

// Source of truth for "what counts as a content-bearing field on a part".
// Record<GeminiPartDataField, _> forces a matching entry whenever a new field
// is added to GeminiPart, so request translators cannot silently start
// dropping it.
const GEMINI_PART_FIELD_TO_KIND: Record<GeminiPartDataField, GeminiPartKind> = {
  text: 'text',
  inlineData: 'inline_data',
  functionCall: 'function_call',
  functionResponse: 'function_response',
  fileData: 'file_data',
  executableCode: 'executable_code',
  codeExecutionResult: 'code_execution_result',
};

const GEMINI_PART_DATA_FIELDS = Object.keys(GEMINI_PART_FIELD_TO_KIND) as GeminiPartDataField[];

// Classify the part by its single content-bearing field. Returns null when
// the part only carries a thoughtSignature (a valid signature carrier with
// no body). Throws when the part sets zero or multiple content fields —
// both are silent-data-loss shapes the request translators must refuse
// rather than coerce.
export const geminiPartKind = (part: GeminiPart): GeminiPartKind | null => {
  const presentFields = GEMINI_PART_DATA_FIELDS.filter(field => part[field] !== undefined);
  if (presentFields.length === 1) return GEMINI_PART_FIELD_TO_KIND[presentFields[0]];
  if (presentFields.length > 1) {
    throw new Error(`Gemini part sets conflicting content fields: ${presentFields.join(', ')}.`);
  }
  if (part.thoughtSignature !== undefined) return null;
  const keys = Object.keys(part);
  throw new Error(`Gemini part has no recognized content. Keys present: ${keys.length ? keys.join(', ') : '(none)'}.`);
};

export const geminiPartText = (part: GeminiPart): string | null => (typeof part.text === 'string' ? part.text : null);

export const geminiThoughtText = (part: GeminiPart): string | null => (part.thought === true && typeof part.text === 'string' ? part.text : null);

export const geminiVisibleText = (part: GeminiPart): string | null => (part.thought === true ? null : geminiPartText(part));

export const geminiText = (content?: GeminiContent): string | null => {
  const texts = content?.parts.map(geminiPartText).filter((text): text is string => text !== null);

  return texts?.length ? texts.join('\n\n') : null;
};

export const geminiInlineData = (part: GeminiPart): { mimeType: GeminiSupportedImageMimeType; data: string } | null => {
  const inlineData = part.inlineData;
  if (!inlineData) return null;
  if (!GEMINI_SUPPORTED_IMAGE_MIME_TYPES.includes(inlineData.mimeType as GeminiSupportedImageMimeType)) return null;

  return {
    mimeType: inlineData.mimeType as GeminiSupportedImageMimeType,
    data: inlineData.data,
  };
};

export const geminiInlineDataUrl = (part: GeminiPart): string | null => {
  const inlineData = geminiInlineData(part);
  return inlineData ? `data:${inlineData.mimeType};base64,${inlineData.data}` : null;
};

export const geminiFunctionCallPart = (part: GeminiPart, ids: GeminiToolCallIds, turnIndex: number, partIndex: number): GeminiFunctionCallPart | null => {
  const call = part.functionCall;
  if (!call) return null;

  const id = call.id ?? geminiToolCallId(turnIndex, partIndex);
  ids[call.name] ??= [];
  ids[call.name].push(id);

  return { call, id };
};

export const geminiFunctionResponsePart = (part: GeminiPart, ids: GeminiToolCallIds, turnIndex: number, partIndex: number, remove: 'first' | 'last' = 'first'): GeminiFunctionResponsePart | null => {
  const response = part.functionResponse;
  if (!response) return null;

  const unmatched = ids[response.name];
  const id = response.id ?? geminiToolCallId(turnIndex, partIndex);
  if (response.id !== undefined) {
    const index = remove === 'first' ? unmatched?.indexOf(response.id) ?? -1 : unmatched?.lastIndexOf(response.id) ?? -1;
    if (index >= 0) unmatched?.splice(index, 1);
    return { response, id };
  }

  return { response, id: unmatched?.shift() ?? id };
};

// Reasoning effort is freeform on the inbound IRs — the gateway never
// enum-gates these values at the wire boundary — so the translate-side
// mappers below return whatever Gemini surfaced for `thinkingLevel` /
// derived from `thinkingBudget` verbatim.

export const geminiThinkingLevelEffort = (thinkingConfig?: GeminiThinkingConfig): string | undefined =>
  thinkingConfig?.thinkingLevel;

// Bucket Gemini's numeric `thinkingBudget` back onto the discrete
// `reasoning_effort` axis when the target protocol has no numeric budget
// slot (Chat Completions, Responses). Google publishes per-model
// budget ranges but not effort-name thresholds; the 2048 / 8192 bin
// edges below invert the community convention of using those same
// numbers as the DEFAULT budget per effort tier — treating "medium's
// default is 2048" as "budgets up to and including 2048 read as low
// tier", and "high's default is 8192" as "budgets up to 8192 read as
// medium tier".
//
// References:
// - Google Gemini thinking config: https://ai.google.dev/gemini-api/docs/thinking
// - AutoReview (community): `THINK_BUDGETS = { low: 512, medium: 2048, high: 8192 }`
//   https://github.com/krzysztofdudek/AutoReview/blob/9bf2ede3a960f5215645bedba41c591829053f5c/scripts/lib/providers/google.mjs#L4
// - LiteLLM (community): `DEFAULT_REASONING_EFFORT_MEDIUM_THINKING_BUDGET = 2048`
//   https://github.com/BerriAI/litellm/blob/88e03e548716a45284597edf2b7f47a7e6a66d5f/litellm/constants.py#L184
export const geminiReasoningEffort = (thinkingConfig?: GeminiThinkingConfig): string | null => {
  if (!thinkingConfig) return null;

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget === 0) return 'none';
    if (thinkingConfig.thinkingBudget < 0) return null;
    if (thinkingConfig.thinkingBudget <= 2048) return 'low';
    if (thinkingConfig.thinkingBudget <= 8192) return 'medium';
    return 'high';
  }

  return geminiThinkingLevelEffort(thinkingConfig) ?? null;
};

export const geminiFunctionDeclarations = (payload: GeminiPayload, allowedNameMode: 'any' | 'all' | 'none'): GeminiFunctionDeclaration[] => {
  const config = payload.toolConfig?.functionCallingConfig;
  const allowedFunctionNames = config?.allowedFunctionNames;
  const allowedNames = allowedFunctionNames?.length && (allowedNameMode === 'all' || (allowedNameMode === 'any' && config?.mode === 'ANY')) ? new Set(allowedFunctionNames) : null;

  return payload.tools?.flatMap(toolGroup => toolGroup.functionDeclarations?.filter(declaration => allowedNames?.has(declaration.name) ?? true) ?? []) ?? [];
};

const geminiSingleAllowedFunctionName = (config?: GeminiFunctionCallingConfig): string | undefined => (config?.allowedFunctionNames?.length === 1 ? config.allowedFunctionNames[0] : undefined);

export const geminiFunctionCallingIntent = (config?: GeminiFunctionCallingConfig): GeminiFunctionCallingIntent | undefined => {
  switch (config?.mode) {
  case 'NONE':
    return { type: 'none' };
  case 'AUTO':
  case 'VALIDATED':
    return { type: 'auto' };
  case 'ANY': {
    const name = geminiSingleAllowedFunctionName(config);
    return name !== undefined ? { type: 'named', name } : { type: 'any' };
  }
  default:
    return undefined;
  }
};

export interface GeminiThoughtSignatureState {
  pendingThoughtSignature?: string;
}

export const appendGeminiThoughtSignature = (state: GeminiThoughtSignatureState, signature: string): void => {
  state.pendingThoughtSignature = `${state.pendingThoughtSignature ?? ''}${signature}`;
};

export const signGeminiPart = (state: GeminiThoughtSignatureState, part: GeminiPart): GeminiPart => {
  if (state.pendingThoughtSignature === undefined) return part;

  const signedPart = {
    ...part,
    thoughtSignature: state.pendingThoughtSignature,
  };
  state.pendingThoughtSignature = undefined;
  return signedPart;
};

export const flushGeminiThoughtSignature = (state: GeminiThoughtSignatureState): GeminiPart[] => (state.pendingThoughtSignature === undefined ? [] : [signGeminiPart(state, { text: '' })]);

export const parseStrictJsonObject = (json: string, subject: string): Record<string, unknown> => {
  if (!json) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Upstream ${subject} was not valid JSON.`, {
      cause: error,
    });
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Upstream ${subject} must be a JSON object.`);
  }

  return parsed;
};

// Shape a single-candidate Gemini stream event. Lives in shared because both
// gemini-via-messages and gemini-via-responses produce the same envelope.
export const geminiCandidateEvent = (parts: GeminiPart[], finishReason?: GeminiFinishReason, usageMetadata?: GeminiUsageMetadata): GeminiStreamEvent => ({
  candidates: [
    {
      index: 0,
      content: { role: 'model', parts },
      ...(finishReason !== undefined ? { finishReason } : {}),
    },
  ],
  ...(usageMetadata !== undefined ? { usageMetadata } : {}),
});
