import { chatBodyRequest, chatBodyResponse, defineStage } from '../../pipeline/facts.ts';

export const enterOpenAIResponsesBody = defineStage({
  name: 'openaiResponses.enter-body',
  request: { needs: [...chatBodyRequest, 'openaiResponses'] },
  into: {
    body: {
      request: { needs: [...chatBodyRequest, 'openaiResponses'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'openaiResponses'], provides: [], consumes: [] },
    },
  },
  async execute(facts, scope) {
    return await scope.into.body(facts);
  },
});
