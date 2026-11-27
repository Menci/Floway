import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.dial',
  through: {
    request: { needs: ['http', 'openaiChatCompletions', 'copilot.modelId', 'model'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['openaiChatCompletions?', 'usageModelKey?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const body = { ...facts.openaiChatCompletions, model: modelId, stream: true };
    const http = jsonRequest(facts.http, '/chat/completions', body);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...request, http }), modelId, facts.model.upstreamModelId);
    return failure === undefined ? answer : { ...answer, openaiChatCompletions: httpDialError(failure, formatOpenAIError) };
  },
});
