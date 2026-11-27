import { observePerformance } from '../../../pipeline/performance.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { firstOutputTokenSignal } from '../../shared/first-output-token.ts';
import { eventFrame } from '@floway-dev/protocols/common';

export const measureOpenAIResponsesPerformance = defineStage({
  name: 'openaiResponses.performance',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiResponses', 'usage'], provides: ['openaiResponses', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const startedAt = performance.now();
    const answer = await scope.next(facts);
    const observed = observePerformance(scope, answer.openaiResponses, answer.usage, {
      operation: 'chat',
      upstream: facts.upstream.id,
      model: facts.model.id,
      startedAt: answer.http?.startedAt ?? startedAt,
      isFirstOutput: event => firstOutputTokenSignal(eventFrame(event), 'openaiResponses') !== null,
    });
    return { ...answer, openaiResponses: observed.outcome, usage: observed.usage };
  },
});
