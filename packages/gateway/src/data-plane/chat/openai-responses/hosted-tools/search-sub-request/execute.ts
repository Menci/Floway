import type { Fields } from './facts.ts';
import type { SearchServices } from './services.ts';
import { defineStage, move } from '@floway-dev/pipeline';

export const runWebSearchCall = defineStage<
  Fields<'request.webSearch.action'>,
  Fields<'response.webSearch.ir'> & { 'response.usage.billable': readonly never[] },
  SearchServices
>({
  name: 'runWebSearchCall',
  return: { provides: ['response.webSearch.ir', 'response.usage.billable'] },
  execute: async (facts, use) => move({
    ...facts,
    'response.webSearch.ir': await use.searchCall(),
    // No model was called, so there is no entity to bill: what the backend charges is accounted
    // per api key by the operations as they run.
    'response.usage.billable': [],
  }) as never,
});
