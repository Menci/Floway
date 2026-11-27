import type { GatewayRequestFacts, GatewayResponseFacts } from './facts.ts';
import type { GatewayServices } from './services.ts';
import { factSpace } from '@floway-dev/pipeline';

const { defineStage } = factSpace<
  Pick<GatewayRequestFacts, 'model' | 'upstream'>,
  Pick<GatewayResponseFacts, 'usage'>,
  Pick<GatewayServices, 'recordUsage'>
>();

export const storeUsage = defineStage({
  name: 'store-usage',
  through: {
    request: { needs: ['model', 'upstream'], provides: [], consumes: [] },
    response: { needs: ['usage'], provides: ['usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { model, upstream } = facts;
    const usage = scope.wrapDeferred(answer.usage, async (source, producer) => {
      const observed = await producer.read(source);
      if (observed.kind === 'observed' && 'modelKey' in observed) {
        const identity = {
          model: model.id,
          upstream: upstream.id,
          modelKey: observed.modelKey,
          pricing: model.pricing ?? null,
        };
        for (const entry of observed.usage) {
          producer.detach(async ({ services }) => await services.recordUsage(identity, entry));
        }
      }
      return observed;
    });
    return { ...answer, usage };
  },
});
