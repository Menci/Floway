import { observePerformance } from '../../../pipeline/performance.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { firstOutputTokenSignal } from '../../shared/first-output-token.ts';
import { eventFrame } from '@floway-dev/protocols/common';

export const measureGeminiGenerateContentPerformance = defineStage({
  name: 'geminiGenerateContent.performance',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['http', 'geminiGenerateContent', 'usage'], provides: ['geminiGenerateContent', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const startedAt = performance.now();
    const answer = await scope.next(facts);
    const observed = observePerformance(scope, answer.geminiGenerateContent, answer.usage, {
      operation: 'chat',
      upstream: facts.upstream.id,
      model: facts.model.id,
      startedAt: answer.http?.startedAt ?? startedAt,
      isFirstOutput: event => firstOutputTokenSignal(eventFrame(event), 'geminiGenerateContent') !== null,
    });
    return { ...answer, geminiGenerateContent: observed.outcome, usage: observed.usage };
  },
});
