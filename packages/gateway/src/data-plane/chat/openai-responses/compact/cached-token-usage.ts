import { defineStage } from '../../../pipeline/facts.ts';
import { normalizeOpenAIResponsesResourceUsage } from '../cached-token-usage.ts';

export const normalizeOpenAIResponsesCompactUsage = defineStage({
  name: 'openaiResponsesCompact.normalize-exclusive-cached-tokens',
  through: {
    request: { needs: ['provider.model', 'provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponsesCompact'], provides: ['response.openaiResponsesCompact'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.openaiResponsesCompact'];
    if (outcome.kind !== 'result') return answer;

    const model = facts['provider.model'];
    const identity = `${facts['provider.upstream'].id}/${model.id}`;
    const result = normalizeOpenAIResponsesResourceUsage(outcome.result, model.enabledFlags.includes('usage-exclusive-cached-tokens'), identity);
    return result === outcome.result ? answer : { ...answer, 'response.openaiResponsesCompact': { kind: 'result', result } };
  },
});
