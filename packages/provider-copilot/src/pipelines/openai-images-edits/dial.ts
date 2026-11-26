import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { dispatchedAnswer, wireRequest } from '../shared/wire-request.ts';
import { httpDialError, serializeOpenAIImagesEditsBody } from '@floway-dev/provider';

export const dial = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.dial',
  through: {
    request: { needs: ['request.http', 'request.openaiImagesEdits'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.http', 'response.http.error?'], provides: ['response.openaiImagesEdits?', 'response.usageModelKey?'], consumes: ['response.http.error'] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiImagesEdits'];
    const model = payload.parameters.model;
    if (typeof model !== 'string') throw new TypeError('Copilot image edits requires a selected model');
    const { model: _model, ...parameters } = payload.parameters;
    const body = await serializeOpenAIImagesEditsBody({ ...payload, parameters }, model);
    const outbound = { path: '/v1/images/edits', modelId: model, ...body };
    const http = wireRequest(facts['request.http'], outbound);
    const { failure, answer } = dispatchedAnswer(await scope.next({ ...facts, 'request.http': http }), outbound);
    return failure === undefined ? answer : { ...answer, 'response.openaiImagesEdits': httpDialError(failure, formatOpenAIError) };
  },
});
