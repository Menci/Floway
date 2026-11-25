import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { enterProvider } from '../../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../../pipeline/performance.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { measureOpenAIImagesUsage } from '../../usage.ts';

export const openAIImagesGenerationsEgress = {
  stages: [
    storeUsage,
    recordPerformance('response.openaiImagesGenerations', 'image_generation'),
    computeUsage('response.openaiImagesGenerations', { kind: 'billable', result: measureOpenAIImagesUsage }),
  ],
  ...enterProvider('openaiImagesGenerations'),
};
