import { defineStage } from '../../pipeline/facts.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

export const includeOpenAICompletionsUsage = defineStage({
  name: 'openaiCompletions.include-usage',
  through: {
    request: { needs: ['openaiCompletions'], provides: ['openaiCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const request = facts.openaiCompletions;
    if (request.stream !== true) return await scope.next(facts);
    const options = isJsonObject(request.stream_options) ? request.stream_options : {};
    return await scope.next({ ...facts, openaiCompletions: { ...request, stream_options: { ...options, include_usage: true } } });
  },
});
