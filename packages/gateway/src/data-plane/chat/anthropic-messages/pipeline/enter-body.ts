import { chatBodyRequest, chatBodyResponse, defineStage } from '../../pipeline/facts.ts';

export const enterAnthropicMessagesBody = defineStage({
  name: 'anthropicMessages.enter-body',
  request: { needs: [...chatBodyRequest, 'anthropicMessages'] },
  into: {
    body: {
      request: { needs: [...chatBodyRequest, 'anthropicMessages'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'anthropicMessages'], provides: [], consumes: [] },
    },
  },
  async execute(facts, scope) {
    return await scope.into.body(facts);
  },
});
