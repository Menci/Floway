import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.openaiEmbeddings.dial',
  through: {
    request: { needs: ['http', 'openaiEmbeddings', 'copilot.modelId', 'model'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['openaiEmbeddings?', 'usageModelKey?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const body = { ...facts.openaiEmbeddings, model: modelId };
    const http = jsonRequest(facts.http, '/embeddings', body);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...request, http }), modelId, facts.model.upstreamModelId);
    return failure === undefined ? answer : { ...answer, openaiEmbeddings: httpDialError(failure, formatOpenAIError) };
  },
});
