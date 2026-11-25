import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { enterProvider } from '../../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../../pipeline/performance.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { openAIImagesUsage, openAIImagesVerdict } from '../observe-stream.ts';

export const openAIImagesEditsEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.openaiImagesEdits'),
    storeUsage,
    recordPerformance('response.openaiImagesEdits', 'image_edit', { firstOutput: () => false, verdict: openAIImagesVerdict }),
    computeUsage('response.openaiImagesEdits', openAIImagesUsage, openAIImagesVerdict),
  ],
  ...enterProvider('openaiImagesEdits'),
};
