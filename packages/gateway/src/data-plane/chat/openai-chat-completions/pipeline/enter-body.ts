import { chatBodyRequest, chatBodyResponse, defineStage } from '../../pipeline/facts.ts';

export const enterOpenAIChatCompletionsBody = defineStage({
  name: 'openaiChatCompletions.enter-body',
  request: { needs: [...chatBodyRequest, 'openaiChatCompletions'] },
  into: {
    body: {
      request: { needs: [...chatBodyRequest, 'openaiChatCompletions'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'openaiChatCompletions'], provides: [], consumes: [] },
    },
  },
  async execute(facts, scope) {
    return await scope.into.body(facts);
  },
});
