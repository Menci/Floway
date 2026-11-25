import { defineCopilotStage } from '../facts.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { transform } from '@floway-dev/pipeline';

// https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
export const serializeOpenAIChatCompletions = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.serialize',
  through: {
    request: { needs: ['request.openaiChatCompletions', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const body = { ...facts['request.openaiChatCompletions'], model: facts['copilot.modelId'], stream: true };
      return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], '/chat/completions', body) };
    },
  })),
});
