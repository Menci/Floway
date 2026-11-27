import { chatBodyRequest, chatBodyResponse, defineStage } from '../../pipeline/facts.ts';

export const enterGeminiGenerateContentBody = defineStage({
  name: 'geminiGenerateContent.enter-body',
  request: { needs: [...chatBodyRequest, 'geminiGenerateContent'] },
  into: {
    body: {
      request: { needs: [...chatBodyRequest, 'geminiGenerateContent'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'geminiGenerateContent'], provides: [], consumes: [] },
    },
  },
  async execute(facts, scope) {
    return await scope.into.body(facts);
  },
});
