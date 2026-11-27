import { defineStage } from './facts.ts';
import { normalizeOpenAIResponsesResourceUsage } from '../../chat/openai-responses/pipeline/cached-token-usage.ts';

export const normalizeOpenAIResponsesCompactUsage = defineStage({
  name: 'openaiResponsesCompact.normalize-exclusive-cached-tokens',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiResponsesCompact;
    if (outcome.kind !== 'result') return answer;
    const { model, upstream } = facts;
    const result = normalizeOpenAIResponsesResourceUsage(outcome.result, model.enabledFlags.includes('usage-exclusive-cached-tokens'), `${upstream.id}/${model.id}`);
    return result === outcome.result ? answer : { ...answer, openaiResponsesCompact: { kind: 'result', result } };
  },
});
