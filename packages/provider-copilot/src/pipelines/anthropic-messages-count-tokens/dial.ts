import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest, wireRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/provider';

export const dial = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.dial',
  through: {
    request: { needs: ['request.http', 'request.anthropicMessagesCountTokens'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.http', 'response.http.error?'], provides: ['response.anthropicMessagesCountTokens?', 'response.usageModelKey?'], consumes: ['response.http.error'] },
  },
  async execute(facts, scope) {
    const outbound = jsonRequest('/v1/messages/count_tokens', facts['request.anthropicMessagesCountTokens']);
    const http = wireRequest(facts['request.http'], outbound);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
    return failure === undefined ? answer : { ...answer, 'response.anthropicMessagesCountTokens': httpDialError(failure, formatAnthropicMessagesError) };
  },
});
