import { COMPACTION_TRIGGER } from '../../compaction.ts';
import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest, wireRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/provider';

export const dial = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.dial',
  through: {
    request: { needs: ['request.http', 'request.openaiResponsesCompact'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiResponsesCompact?', 'response.usageModelKey?'], consumes: ['response.http.error'] },
  },
  async execute(facts, scope) {
    const { store: _store, ...payload } = facts['request.openaiResponsesCompact'];
    const outbound = jsonRequest('/responses', { ...payload, input: [...payload.input, COMPACTION_TRIGGER], stream: false });
    const http = wireRequest(facts['request.http'], outbound);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
    return failure === undefined ? answer : { ...answer, 'response.openaiResponsesCompact': httpDialError(failure, formatOpenAIError) };
  },
});
