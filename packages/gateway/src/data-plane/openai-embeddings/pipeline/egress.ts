import { computeUsage } from '../../pipeline/compute-usage.ts';
import { enterProvider } from '../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../pipeline/performance.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { measureOpenAIEmbeddingsUsage } from '../usage.ts';

export const openAIEmbeddingsEgress = {
  stages: [
    storeUsage,
    recordPerformance('response.openaiEmbeddings', 'embeddings'),
    computeUsage('response.openaiEmbeddings', { kind: 'billable', result: measureOpenAIEmbeddingsUsage }),
  ],
  ...enterProvider('openaiEmbeddings'),
};
