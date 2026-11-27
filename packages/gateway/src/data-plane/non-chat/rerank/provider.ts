import { defineStage } from './facts.ts';
import { customPipelines } from '@floway-dev/upstream-custom';

export const targets = { custom: customPipelines.rerank };

export const provider = defineStage({
  name: 'rerank.provider',
  request: { needs: ['http', 'upstream', 'model', 'rerank'] },
  into: {
    custom: {
      request: { needs: ['http', 'upstream', 'model', 'rerank'], provides: [], consumes: [] },
      response: { needs: ['http', 'rerank'], provides: ['rerankTargetDialect'], consumes: [] },
    },
  },
  async execute(facts, scope) {
    if (facts.upstream.kind !== 'custom') throw new Error(`The ${facts.upstream.kind} upstream has no rerank pipeline`);
    const { rerankTarget } = facts.model;
    if (rerankTarget === undefined) throw new Error(`Rerank model ${facts.model.id} has no outbound target`);
    const answer = await scope.into.custom(facts);
    return { ...answer, rerankTargetDialect: rerankTarget.protocol };
  },
});
