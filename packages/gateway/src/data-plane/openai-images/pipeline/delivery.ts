import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { move } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const delivery = move({ kind: 'json' } as const);

export const openAIImagesDelivery = (operation: 'openaiImagesEdits' | 'openaiImagesGenerations') => defineStage({
  name: `${operation}.delivery`,
  through: {
    request: { needs: [], provides: ['request.delivery'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    return await scope.next({ ...facts, 'request.delivery': delivery });
  },
});
