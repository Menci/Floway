import { executeLocalAlphaSearch } from './execute-alpha.ts';
import { executeLocalWebSearch } from './execute.ts';
import { compose } from './facts.ts';
import { httpEntry } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

export const localWebSearchOperation = asEntry(compose('local-web-search', {
  entry: [...httpEntry, 'webSearch'],
  exit: ['http', 'webSearch'],
  stages: [],
  ending: executeLocalWebSearch,
}));

export const localAlphaSearchOperation = asEntry(compose('local-alpha-search', {
  entry: [...httpEntry, 'alphaSearchBatch'],
  exit: ['http', 'alphaSearchBatch'],
  stages: [],
  ending: executeLocalAlphaSearch,
}));

export type { WebSearchRequest, WebSearchResult } from './facts.ts';
