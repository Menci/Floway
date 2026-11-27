import { defineStage } from '../../pipeline/facts.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

const stripPartFields = (content: GeminiGenerateContentContent): GeminiGenerateContentContent =>
  content.parts === undefined ? content : {
    ...content,
    parts: content.parts.flatMap(({ fileData: _fileData, executableCode: _code, codeExecutionResult: _result, ...part }) =>
      Object.keys(part).length > 0 ? [part] : []),
  };

export const stripUnsupportedPartFieldsFromPayload = <Payload extends Pick<GeminiGenerateContentPayload, 'contents' | 'systemInstruction'>>(
  payload: Payload,
): Payload => ({
  ...payload,
  ...(payload.contents === undefined ? {} : { contents: payload.contents.map(stripPartFields) }),
  ...(payload.systemInstruction === undefined ? {} : { systemInstruction: stripPartFields(payload.systemInstruction) }),
});

export const stripGeminiGenerateContentUnsupportedPartFields = defineStage({
  name: 'geminiGenerateContent.strip-unsupported-part-fields',
  through: {
    request: { needs: ['geminiGenerateContent', 'chat.target'], provides: ['geminiGenerateContent'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['chat.target'] === 'geminiGenerateContent') return await scope.next(facts);
    return await scope.next({ ...facts, geminiGenerateContent: stripUnsupportedPartFieldsFromPayload(facts.geminiGenerateContent) });
  },
});
