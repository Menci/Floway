import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { enterProvider } from '../../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../../pipeline/performance.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../../shared/normalize-damaged-upstream-response.ts';
import { openAIImagesUsage, openAIImagesVerdict } from '../observe-stream.ts';

export const openAIImagesGenerationsEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.openaiImagesGenerations'),
    storeUsage,
    recordPerformance('response.openaiImagesGenerations', 'image_generation', { firstOutput: () => false, verdict: openAIImagesVerdict }),
    computeUsage('response.openaiImagesGenerations', openAIImagesUsage, openAIImagesVerdict),
  ],
  ...enterProvider('openaiImagesGenerations'),
};
