import { computeUsage } from '../../pipeline/compute-usage.ts';
import { enterProvider } from '../../pipeline/enter-provider.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../shared/normalize-damaged-upstream-response.ts';

export const alphaSearchEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.alphaSearch'),
    storeUsage,
    computeUsage('response.alphaSearch', { kind: 'unbillable' }),
  ],
  ...enterProvider('alphaSearch'),
};
