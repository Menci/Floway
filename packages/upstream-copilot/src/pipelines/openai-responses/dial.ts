import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.openaiResponses.dial',
  through: {
    request: { needs: ['http', 'openaiResponses', 'copilot.modelId', 'model'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['openaiResponses?', 'usageModelKey?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const body = { ...facts.openaiResponses, model: modelId, stream: true };
    const http = jsonRequest(facts.http, '/responses', body);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...request, http }), modelId, facts.model.upstreamModelId);
    return failure === undefined ? answer : { ...answer, openaiResponses: httpDialError(failure, formatOpenAIError) };
  },
});
