import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

const translatedContent = (content: GeminiGenerateContentContent): GeminiGenerateContentContent => {
  if (content.parts === undefined) return content;
  const parts = content.parts.flatMap(({ fileData: _file, executableCode: _code, codeExecutionResult: _result, ...part }) =>
    Object.keys(part).length > 0 ? [part] : []);
  return { ...content, parts };
};

export const stripUnsupportedPartFields = rewriteChatRequest(
  'stripUnsupportedPartFields', 'request.geminiGenerateContent',
  (payload: GeminiGenerateContentRequest, _candidate, targetApi) => targetApi === 'geminiGenerateContent' ? payload : {
    ...payload,
    ...(payload.contents == null ? {} : { contents: payload.contents.map(translatedContent) }),
    ...(payload.systemInstruction == null ? {} : { systemInstruction: translatedContent(payload.systemInstruction) }),
  },
);
