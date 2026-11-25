import { defineCopilotStage } from '../facts.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { transform } from '@floway-dev/pipeline';

// https://platform.claude.com/docs/en/api/messages-count-tokens
export const serializeAnthropicMessagesCountTokens = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.serialize',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const body = { ...facts['request.anthropicMessages'], model: facts['copilot.modelId'] };
      return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], '/v1/messages/count_tokens', body) };
    },
  })),
});
