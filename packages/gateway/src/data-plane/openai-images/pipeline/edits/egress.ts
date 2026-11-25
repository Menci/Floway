import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { enterProvider } from '../../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../../pipeline/performance.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { measureOpenAIImagesUsage } from '../../usage.ts';

export const openAIImagesEditsEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.openaiImagesEdits'),
    storeUsage,
    recordPerformance('response.openaiImagesEdits', 'image_edit'),
    computeUsage('response.openaiImagesEdits', { kind: 'billable', result: measureOpenAIImagesUsage }),
  ],
  ...enterProvider('openaiImagesEdits'),
};
