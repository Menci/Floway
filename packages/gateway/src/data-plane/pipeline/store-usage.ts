import { defineStage } from './facts.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const storeUsage = defineStage({
  name: 'store-usage',
  through: {
    request: { needs: ['request.auth.apiKeyId', 'provider.upstream', 'provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.usage'], provides: ['response.usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const answer = await scope.next(facts);
    const usage = scope.wrapDeferred(answer['response.usage'], async (inner, producer) => {
      const observation = await producer.read(inner);
      if (observation.kind === 'observed' && 'modelKey' in observation) {
        const identity: TelemetryModelIdentity = {
          model: model.id,
          upstream: facts['provider.upstream'].id,
          modelKey: observation.modelKey,
          pricing: model.pricing ?? null,
        };
        for (const entry of observation.usage) {
          producer.detach(async ({ log }) => {
            try {
              await recordUsage(facts['request.auth.apiKeyId'], identity, entry.quantities, entry.pricingFacts);
            } catch (error) {
              log.withError(error).error('Floway failed to record upstream usage');
            }
          });
        }
      }
      return observation;
    });
    return { ...answer, 'response.usage': usage };
  },
});
