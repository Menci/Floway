import type { GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

const geminiGenerateContentToolCallId = (turnIndex: number, partIndex: number): string => `gemini_call_${turnIndex}_${partIndex}`;

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
  // Absent when the source stated no id and no call this reader saw is still
  // awaiting this answer: a target then pairs the result by order, which is
  // what makes it answer a call only a restored turn stated.
  id: string | undefined;
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
  if (response.id !== undefined) {
    const index = remove === 'first' ? unmatched?.indexOf(response.id) ?? -1 : unmatched?.lastIndexOf(response.id) ?? -1;
    if (index >= 0) unmatched?.splice(index, 1);
    return { response, id: response.id };
  }

  // An id-less answer pairs with the oldest call of its name this reader has
  // seen. When none is left, the call it answers came from a turn a sidecar
  // restored, so the result states no id and the target pairs it by position.
  return { response, id: unmatched?.shift() };
};
