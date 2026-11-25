import { validateDecisionResult } from './validate-result.ts';
import { computeUsage } from '../../pipeline/compute-usage.ts';
import { enterProvider } from '../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../pipeline/performance.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../shared/normalize-damaged-upstream-response.ts';
import { measureDamagedDecisionUsage, measureDecisionUsage } from '../usage.ts';

export const decisionEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.decision'),
    storeUsage,
    recordPerformance('response.decision', 'decision'),
    computeUsage('response.decision', { kind: 'billable', result: measureDecisionUsage, error: measureDamagedDecisionUsage }),
    validateDecisionResult,
  ],
  ...enterProvider('decision'),
};
