import { geminiTranslationStage } from './translation-stage.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

/**
 * A translated target has no slot for Gemini's file/code parts, so drop them at
 * source to keep every translated route seeing parts it can express. A native
 * Gemini upstream receives the payload as the client shaped it, parts included.
 */
const stripPartFields = (content: GeminiGenerateContentContent): GeminiGenerateContentContent =>
  content.parts === undefined ? content : {
    ...content,
    parts: content.parts.flatMap(({ fileData: _fileData, executableCode: _code, codeExecutionResult: _result, ...part }) =>
      Object.keys(part).length > 0 ? [part] : []),
  };

export const stripUnsupportedPartFieldsFromPayload = (payload: GeminiGenerateContentPayload): GeminiGenerateContentPayload => ({
  ...payload,
  ...(payload.contents === undefined ? {} : { contents: payload.contents.map(stripPartFields) }),
  ...(payload.systemInstruction === undefined ? {} : { systemInstruction: stripPartFields(payload.systemInstruction) }),
});

export const stripUnsupportedPartFields = geminiTranslationStage('strip-unsupported-part-fields', stripUnsupportedPartFieldsFromPayload);
