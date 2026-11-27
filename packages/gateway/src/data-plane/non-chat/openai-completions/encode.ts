import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, encodedResponse, encodeSse, errorResponse } from '../shared/http.ts';
import { doneFrame, eventFrame, isJsonObject, isOpenAIUsageOnlyEventShape } from '@floway-dev/protocols/common';

export const encodeOpenAICompletions = defineStage({
  name: 'openaiCompletions.encode',
  through: {
    request: { needs: ['openaiCompletions'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiCompletions', 'candidate?'], provides: ['http'], consumes: ['openaiCompletions'] },
  },
  async execute(facts, scope) {
    const { openaiCompletions: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      scope.services.dump?.error(outcome.source === 'upstream' ? 'upstream' : 'gateway', answer.candidate?.upstreamId);
      return { ...answer, http: errorResponse(answer.http, outcome) };
    }
    const { http } = answer;
    if (http === null) throw new Error('OpenAICompletions success requires an HTTP response');
    if (outcome.kind === 'result') return { ...answer, http: jsonResponse(http, outcome.result) };
    const options = facts.openaiCompletions.stream_options;
    const includeUsage = isJsonObject(options) && options.include_usage === true;
    const { dump } = scope.services;
    const body = encodeSse(outcome.stream, scope, event => {
      const frame = eventFrame(event);
      if (includeUsage || !isOpenAIUsageOnlyEventShape(event)) return frame;
      dump?.frame(frame);
      return null;
    }, doneFrame);
    return { ...answer, http: encodedResponse(http, body, 'text/event-stream') };
  },
});
