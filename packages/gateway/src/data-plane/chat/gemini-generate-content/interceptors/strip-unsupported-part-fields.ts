import type { GeminiGenerateContentInterceptor } from './types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

/**
 * Gemini generateContent file/code parts have no current equivalent in the upstream target
 * graph. Drop them at source so every Gemini generateContent route target sees translatable
 * parts.
 */
const stripPartFields = (parts: GeminiGenerateContentPart[]): GeminiGenerateContentPart[] =>
  parts.filter(part => {
    delete part.fileData;
    delete part.executableCode;
    delete part.codeExecutionResult;
    return Object.keys(part).length > 0;
  });

export const stripUnsupportedPartFieldsFromPayload = (payload: GeminiGenerateContentPayload): void => {
  payload.contents?.forEach(content => {
    content.parts = stripPartFields(content.parts);
  });
  if (payload.systemInstruction) {
    payload.systemInstruction.parts = stripPartFields(payload.systemInstruction.parts);
  }
};

export const stripUnsupportedPartFields: GeminiGenerateContentInterceptor = (ctx, _gatewayCtx, run) => {
  stripUnsupportedPartFieldsFromPayload(ctx.payload);
  return run();
};
