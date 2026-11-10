const geminiGenerateContentToolCallId = (turnIndex: number, partIndex: number): string => `gemini_call_${turnIndex}_${partIndex}`;

import type { GeminiGenerateContentFunctionCallingConfig, GeminiGenerateContentFunctionDeclaration, GeminiGenerateContentPayload, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

export type GeminiGenerateContentToolCallIds = Record<string, string[]>;

export type GeminiGenerateContentFunctionCall = NonNullable<GeminiGenerateContentPart['functionCall']>;
export type GeminiGenerateContentFunctionResponse = NonNullable<GeminiGenerateContentPart['functionResponse']>;

export type GeminiGenerateContentFunctionCallingIntent = { type: 'none' } | { type: 'auto' } | { type: 'any' } | { type: 'named'; name: string };

export interface GeminiGenerateContentFunctionCallPart {
  call: GeminiGenerateContentFunctionCall;
  id: string;
}

export interface GeminiGenerateContentFunctionResponsePart {
  response: GeminiGenerateContentFunctionResponse;
  id: string;
}

export const geminiGenerateContentFunctionCallPart = (part: GeminiGenerateContentPart, ids: GeminiGenerateContentToolCallIds, turnIndex: number, partIndex: number): GeminiGenerateContentFunctionCallPart | null => {
  const call = part.functionCall;
  if (!call) return null;

  const id = call.id ?? geminiGenerateContentToolCallId(turnIndex, partIndex);
  ids[call.name] ??= [];
  ids[call.name].push(id);

  return { call, id };
};

export const geminiGenerateContentFunctionResponsePart = (part: GeminiGenerateContentPart, ids: GeminiGenerateContentToolCallIds, turnIndex: number, partIndex: number, remove: 'first' | 'last' = 'first'): GeminiGenerateContentFunctionResponsePart | null => {
  const response = part.functionResponse;
  if (!response) return null;

  const unmatched = ids[response.name];
  const id = response.id ?? geminiGenerateContentToolCallId(turnIndex, partIndex);
  if (response.id !== undefined) {
    const index = remove === 'first' ? unmatched?.indexOf(response.id) ?? -1 : unmatched?.lastIndexOf(response.id) ?? -1;
    if (index >= 0) unmatched?.splice(index, 1);
    return { response, id };
  }

  return { response, id: unmatched?.shift() ?? id };
};

export const geminiGenerateContentFunctionDeclarations = (payload: GeminiGenerateContentPayload, allowedNameMode: 'any' | 'all' | 'none'): GeminiGenerateContentFunctionDeclaration[] => {
  const config = payload.toolConfig?.functionCallingConfig;
  const allowedFunctionNames = config?.allowedFunctionNames;
  const allowedNames = allowedFunctionNames?.length && (allowedNameMode === 'all' || (allowedNameMode === 'any' && config?.mode === 'ANY')) ? new Set(allowedFunctionNames) : null;

  return payload.tools?.flatMap(toolGroup => toolGroup.functionDeclarations?.filter(declaration => allowedNames?.has(declaration.name) ?? true) ?? []) ?? [];
};

const geminiGenerateContentSingleAllowedFunctionName = (config?: GeminiGenerateContentFunctionCallingConfig): string | undefined => (config?.allowedFunctionNames?.length === 1 ? config.allowedFunctionNames[0] : undefined);

export const geminiGenerateContentFunctionCallingIntent = (config?: GeminiGenerateContentFunctionCallingConfig): GeminiGenerateContentFunctionCallingIntent | undefined => {
  switch (config?.mode) {
  case 'NONE':
    return { type: 'none' };
  case 'AUTO':
  case 'VALIDATED':
    return { type: 'auto' };
  case 'ANY': {
    const name = geminiGenerateContentSingleAllowedFunctionName(config);
    return name !== undefined ? { type: 'named', name } : { type: 'any' };
  }
  default:
    return undefined;
  }
};
