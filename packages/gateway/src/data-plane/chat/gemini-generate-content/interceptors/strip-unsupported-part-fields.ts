import type { GeminiGenerateContentInterceptor } from './types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';

/**
 * A translated target has no slot for Gemini's file/code parts, so drop them at
 * source to keep every translated route seeing parts it can express. A native
 * Gemini upstream receives the payload as the client shaped it, parts included.
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
    if (content.parts !== undefined) content.parts = stripPartFields(content.parts);
  });
  if (payload.systemInstruction?.parts !== undefined) {
    payload.systemInstruction.parts = stripPartFields(payload.systemInstruction.parts);
  }
};

export const stripUnsupportedPartFields: GeminiGenerateContentInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'geminiGenerateContent') stripUnsupportedPartFieldsFromPayload(ctx.payload);
  return run();
};
