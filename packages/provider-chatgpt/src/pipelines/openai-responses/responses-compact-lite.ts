import { chatgptFactSpace } from '../facts.ts';
import { prepareChatGPTResponsesLiteRequest } from './responses-lite.ts';

const { defineStage } = chatgptFactSpace;

export const openaiResponsesCompactLite = defineStage({
  name: 'chatgpt.openaiResponsesCompact.responses-lite',
  through: {
    request: { needs: ['request.http', 'request.openaiResponsesCompact', 'provider.model'], provides: ['request.openaiResponsesCompact', 'request.chatgptResponsesIdentity'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { body, identity } = prepareChatGPTResponsesLiteRequest(facts['request.openaiResponsesCompact'], facts['request.http'].headers, facts['provider.model'], true);
    return await scope.next({ ...facts, 'request.openaiResponsesCompact': body, 'request.chatgptResponsesIdentity': identity });
  },
});
