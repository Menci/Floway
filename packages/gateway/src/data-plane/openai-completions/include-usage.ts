import { defineStage } from '../pipeline/facts.ts';

const payload = ['request.openaiCompletions'] as const;

export const includeOpenAICompletionsUsage = defineStage({
  name: 'openaiCompletions.include-usage',
  through: {
    request: { needs: payload, provides: payload, consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const request = facts['request.openaiCompletions'];
    if (request.stream !== true) return await scope.next(facts);
    const options = request.stream_options as Record<string, unknown> | null | undefined;
    return await scope.next({
      ...facts,
      'request.openaiCompletions': { ...request, stream_options: { ...options, include_usage: true } },
    });
  },
});
