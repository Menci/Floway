import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest, wireRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/provider';

export const dial = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.dial',
  through: {
    request: { needs: ['request.http', 'request.openaiChatCompletions'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiChatCompletions?', 'response.usageModelKey?'], consumes: ['response.http.error'] },
  },
  async execute(facts, scope) {
    const outbound = jsonRequest('/chat/completions', { ...facts['request.openaiChatCompletions'], stream: true });
    const http = wireRequest(facts['request.http'], outbound);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
    return failure === undefined ? answer : { ...answer, 'response.openaiChatCompletions': httpDialError(failure, formatOpenAIError) };
  },
});
