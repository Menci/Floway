import type { GeminiGenerateContentFinishReason, GeminiGenerateContentPart, GeminiGenerateContentStreamEvent, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';

export interface GeminiGenerateContentThoughtSignatureState {
  pendingThoughtSignature?: string;
}

export const setGeminiGenerateContentThoughtSignature = (state: GeminiGenerateContentThoughtSignatureState, signature: string): void => {
  state.pendingThoughtSignature = signature;
};

export const signGeminiGenerateContentPart = (state: GeminiGenerateContentThoughtSignatureState, part: GeminiGenerateContentPart): GeminiGenerateContentPart => {
  if (state.pendingThoughtSignature === undefined) return part;

  const signedPart = {
    ...part,
    thoughtSignature: state.pendingThoughtSignature,
  };
  state.pendingThoughtSignature = undefined;
  return signedPart;
};

export const flushGeminiGenerateContentThoughtSignature = (state: GeminiGenerateContentThoughtSignatureState): GeminiGenerateContentPart[] => (state.pendingThoughtSignature === undefined ? [] : [signGeminiGenerateContentPart(state, { text: '' })]);

// Both upstream protocols produce this single-candidate GenerateContent envelope.
export const geminiGenerateContentCandidateEvent = (parts: GeminiGenerateContentPart[], finishReason?: GeminiGenerateContentFinishReason, usageMetadata?: GeminiGenerateContentUsageMetadata, finishMessage?: string): GeminiGenerateContentStreamEvent => ({
  candidates: [
    {
      index: 0,
      content: { role: 'model', parts },
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(finishMessage !== undefined ? { finishMessage } : {}),
    },
  ],
  ...(usageMetadata !== undefined ? { usageMetadata } : {}),
});
