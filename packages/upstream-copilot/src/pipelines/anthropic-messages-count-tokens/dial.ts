import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { jsonRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.dial',
  through: {
    request: { needs: ['http', 'anthropicMessagesCountTokens', 'copilot.modelId'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['anthropicMessagesCountTokens?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const body = { ...facts.anthropicMessagesCountTokens, model: modelId };
    const http = jsonRequest(facts.http, '/v1/messages/count_tokens', body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...request, http });
    return failure === undefined ? answer : { ...answer, anthropicMessagesCountTokens: httpDialError(failure, formatAnthropicMessagesError) };
  },
});
