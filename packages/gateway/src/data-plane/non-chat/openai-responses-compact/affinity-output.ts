import { defineStage } from './facts.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../../chat/openai-responses/affinity/egress.ts';
import { syntheticEventsFromCompaction } from '../../chat/openai-responses/items/output.ts';
import { materializeOpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';

export const wrapOpenAIResponsesCompactAffinity = defineStage({
  name: 'openaiResponsesCompact.affinity-output',
  through: {
    request: { needs: ['upstream', 'model', 'aliasRules'], provides: [], consumes: [] },
    response: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
  },
  async execute({ upstream, model, aliasRules, ...facts }, scope) {
    const answer = await scope.next({ ...facts, upstream, model, aliasRules });
    const outcome = answer.openaiResponsesCompact;
    if (outcome.kind !== 'result') return answer;
    const affinity = {
      upstreamId: upstream.id,
      modelId: model.id,
      ...(Object.keys(aliasRules).length === 0 ? {} : { rules: aliasRules }),
      opaqueBlobCompatibilityIdentity: materializeOpaqueBlobCompatibilityIdentity(model.opaqueBlobCompatibilityScope, upstream.id, model.upstreamModelId),
    };
    const frames = wrapOpenAIResponsesAffinityEgress(syntheticEventsFromCompaction(outcome.result), { affinity, codec: scope.services.affinity });
    return { ...answer, openaiResponsesCompact: { kind: 'result', result: await collectOpenAIResponsesProtocolEventsToResult(frames) } };
  },
});
