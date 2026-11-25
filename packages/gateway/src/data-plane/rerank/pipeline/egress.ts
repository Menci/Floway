import { computeUsage } from '../../pipeline/compute-usage.ts';
import { enterProvider } from '../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../pipeline/performance.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../shared/normalize-damaged-upstream-response.ts';
import { measureDamagedRerankUsage, measureRerankUsage } from '../usage.ts';

export const rerankEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.rerank'),
    storeUsage,
    recordPerformance('response.rerank', 'rerank'),
    computeUsage('response.rerank', { kind: 'billable', result: measureRerankUsage, error: measureDamagedRerankUsage }),
  ],
  ...enterProvider('rerank'),
};
