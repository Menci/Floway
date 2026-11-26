import { defineStage } from '../../../pipeline/facts.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/context.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../affinity/egress.ts';
import { syntheticEventsFromCompaction } from '../items/output.ts';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';

export const openAIResponsesCompactAffinityOutput = defineStage({
  name: 'openaiResponsesCompact.affinity-output',
  through: {
    request: { needs: ['provider.model', 'provider.upstream', 'request.aliasRules?'], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponsesCompact'], provides: ['response.openaiResponsesCompact'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.openaiResponsesCompact'];
    if (outcome.kind !== 'result') return answer;

    const rules = facts['request.aliasRules'];
    const affinity = affinityIdentityForCandidate({
      model: facts['provider.model'],
      upstream: facts['provider.upstream'],
      ...(rules === undefined ? {} : { rules }),
    });
    const frames = wrapOpenAIResponsesAffinityEgress(syntheticEventsFromCompaction(outcome.result), {
      affinity,
      codec: scope.services.affinity,
    });
    return {
      ...answer,
      'response.openaiResponsesCompact': { kind: 'result', result: await collectOpenAIResponsesProtocolEventsToResult(frames) },
    };
  },
});
