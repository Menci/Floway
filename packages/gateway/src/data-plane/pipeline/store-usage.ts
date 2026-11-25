import { gatewayFactSpace } from './facts.ts';
import type { UsageRecord } from '../../repo/types.ts';

export interface UsageStoreServices {
  readonly storeUsage: (row: UsageRecord) => Promise<void>;
}

const { defineStage } = gatewayFactSpace<UsageStoreServices>();

export const storeUsage = defineStage({
  name: 'serve.store-usage',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: {
      needs: ['response.usage', 'response.modelKey'],
      provides: [],
      consumes: ['response.usage', 'response.modelKey'],
    },
  },
  async execute(facts, scope) {
    const { 'response.usage': usage, 'response.modelKey': _modelKey, ...response } = await scope.next(facts);
    scope.defer(usage.promise.then(async ({ row }) => {
      if (row === null) return;
      try {
        await scope.services.storeUsage(row);
      } catch (error) {
        scope.log.warn('Floway could not record upstream usage', { error });
      }
    }));
    return response;
  },
});
