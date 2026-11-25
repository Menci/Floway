import { computeUsage } from '../../pipeline/compute-usage.ts';
import { enterProvider } from '../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../pipeline/performance.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../shared/normalize-damaged-upstream-response.ts';
import { measureOpenAICompletionsUsage, observeOpenAICompletionsUsage } from '../usage.ts';

export const openAICompletionsEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.openaiCompletions'),
    storeUsage,
    recordPerformance('response.openaiCompletions', 'text_completion'),
    computeUsage('response.openaiCompletions', {
      kind: 'billable',
      result: measureOpenAICompletionsUsage,
      stream: observeOpenAICompletionsUsage,
    }),
  ],
  ...enterProvider('openaiCompletions'),
};
