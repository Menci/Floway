import { geminiGenerateContentPayload, servesNativeGeminiGenerateContent } from './native-target.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.geminiGenerateContent';

export const stripUnsupportedPartFields = defineStage({
  name: 'geminiGenerateContent.strip-unsupported-part-fields',
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      if (servesNativeGeminiGenerateContent(facts['serve.candidate'])) return facts;
      const { contents, systemInstruction, ...payload } = geminiGenerateContentPayload(facts[key]);
      return {
        ...facts, [key]: move({
          ...payload,
          contents: contents.map(stripContent),
          ...(systemInstruction === undefined ? {} : { systemInstruction: stripContent(systemInstruction) }),
        }),
      };
    },
  })),
});

const stripContent = (content: GeminiGenerateContentContent): GeminiGenerateContentContent => {
  if (content.parts === undefined) return content;
  const parts = content.parts.flatMap(({ fileData: _file, executableCode: _code, codeExecutionResult: _result, ...part }) =>
    Object.keys(part).length > 0 ? [part] : []);
  return { ...content, parts };
};
