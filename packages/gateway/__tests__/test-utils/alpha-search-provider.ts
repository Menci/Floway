import { stubProviderPipeline } from './provider-pipeline.ts';
import type { AlphaSearchDispatcher } from '../../src/data-plane/tools/web-search/alpha-search/upstream.ts';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

export const stubAlphaSearchCandidate = (dispatch: AlphaSearchDispatcher): ModelCandidate => {
  const base = stubModelCandidate();
  return {
    ...base, provider: {
      ...base.provider, pipelines: {
        alphaSearch: stubProviderPipeline('alphaSearch', async (_model, payload, signal, options) => ({
          response: await dispatch(payload, signal, options.headers), modelKey: 'search-model',
        })),
      },
    },
  };
};
