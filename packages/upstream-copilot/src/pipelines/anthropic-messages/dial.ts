import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.anthropicMessages.dial',
  through: {
    request: { needs: ['http', 'anthropicMessages', 'copilot.modelId', 'model'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['anthropicMessages?', 'usageModelKey?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const body = { ...facts.anthropicMessages, model: modelId, stream: true };
    const http = jsonRequest(facts.http, '/v1/messages', body);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...request, http }), modelId, facts.model.upstreamModelId);
    return failure === undefined ? answer : { ...answer, anthropicMessages: httpDialError(failure, formatAnthropicMessagesError) };
  },
});
