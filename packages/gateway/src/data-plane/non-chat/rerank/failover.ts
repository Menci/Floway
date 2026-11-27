import { defineStage } from './facts.ts';
import { selectCandidate } from '../../pipeline/failover.ts';

export const failover = defineStage({
  name: 'rerank.failover',
  through: {
    request: { needs: ['candidates'], provides: ['upstream', 'model'], consumes: ['candidates'] },
    response: { needs: ['http', 'rerank', 'usage'], provides: ['candidate'], consumes: [] },
  },
  async execute({ candidates, ...facts }, scope) {
    return await selectCandidate(candidates, scope,
      ({ upstream, model }) => scope.next({ ...facts, upstream, model }),
      answer => answer.rerank);
  },
});
