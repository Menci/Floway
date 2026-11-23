import type { WebSearchUsageRecord } from '../../../repo/types.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { persistSearchUsage } from '../../pipeline/settlement.ts';
import { type Deferred, defineStage, type ErrorSnapshot } from '@floway-dev/pipeline';

export interface SearchUsageRecords {
  readonly 'response.searchUsage.records': readonly WebSearchUsageRecord[];
}

export interface SearchUsageSettlementFacts {
  readonly 'response.searchUsage.settlement': Deferred<{ readonly persisted: boolean; readonly errors: readonly ErrorSnapshot[] }>;
}

export const writeSearchUsage = defineStage<object, object, SearchUsageRecords, SearchUsageSettlementFacts, Pick<GatewayServices, 'searchUsageStore'>>({
  name: 'writeSearchUsage',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.searchUsage.records'],
      consumes: ['response.searchUsage.records'],
      provides: ['response.searchUsage.settlement'],
    },
  },
  execute: async (facts, next, env) => {
    const { 'response.searchUsage.records': records, ...response } = await next(facts);
    const settlement = Promise.all(records.map(row => persistSearchUsage(row, env.services.searchUsageStore, env.log))).then(results => {
      const errors = results.flatMap(result => result.persisted ? [] : [result.error]);
      return { persisted: errors.length === 0, errors };
    });
    return { ...response, 'response.searchUsage.settlement': env.defer('web search usage settlement', settlement) };
  },
});
