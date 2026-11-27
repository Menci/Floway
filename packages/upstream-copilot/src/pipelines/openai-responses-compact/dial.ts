import { COMPACTION_TRIGGER } from '../../compaction.ts';
import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, jsonRequest } from '../shared/wire-request.ts';
import { httpDialError } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.dial',
  through: {
    request: { needs: ['http', 'openaiResponsesCompact', 'copilot.modelId', 'model'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['openaiResponsesCompact?', 'usageModelKey?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const { store: _store, input, ...payload } = facts.openaiResponsesCompact;
    const body = { ...payload, input: [...input, COMPACTION_TRIGGER], stream: false, model: modelId };
    const http = jsonRequest(facts.http, '/responses', body);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...request, http }), modelId, facts.model.upstreamModelId);
    return failure === undefined ? answer : { ...answer, openaiResponsesCompact: httpDialError(failure, formatOpenAIError) };
  },
});
