import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, wireRequest } from '../shared/wire-request.ts';
import { httpDialError, serializeOpenAIImagesEditsBody } from '@floway-dev/upstream';

export const dial = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.dial',
  through: {
    request: { needs: ['http', 'openaiImagesEdits', 'copilot.modelId', 'model'], provides: ['http'], consumes: ['copilot.modelId'] },
    response: { needs: ['http', 'http.error?'], provides: ['openaiImagesEdits?', 'usageModelKey?'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'copilot.modelId': modelId, ...request } = facts;
    const { body, contentType } = await serializeOpenAIImagesEditsBody(facts.openaiImagesEdits, modelId);
    const http = wireRequest(facts.http, '/v1/images/edits', body, contentType);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...request, http }), modelId, facts.model.upstreamModelId);
    return failure === undefined ? answer : { ...answer, openaiImagesEdits: httpDialError(failure, formatOpenAIError) };
  },
});
