import type { UsageFilters, UsageGroupBy, UsageMetric, UsageRange } from './types';
import { oneOf, repeatedValues } from '../../lib/search-params';

export interface UsageUrlState {
  range: UsageRange;
  groupBy: UsageGroupBy;
  filters: UsageFilters;
  metric: UsageMetric;
  hidden: string[];
  hiddenSearch: string[];
}

const usageRangeValues: UsageRange[] = ['today', '7d', '30d'];
const usageMetricValues: UsageMetric[] = ['requests', 'cost', 'total', 'input', 'output', 'prefill', 'cached', 'cachedRate', 'cacheCreation', 'cacheHitRate'];
const usageGroupByValues: UsageGroupBy[] = ['model', 'upstream', 'keyId', 'userId'];

export const parseUsageUrlState = (search: URLSearchParams): UsageUrlState => {
  const groupBy = oneOf(search.get('g'), usageGroupByValues, 'model');
  const filters: UsageFilters = {
    model: repeatedValues(search, 'fm'),
    upstream: repeatedValues(search, 'fu'),
    userId: repeatedValues(search, 'fusr'),
    keyId: repeatedValues(search, 'fk'),
  };
  if (groupBy === 'userId' || groupBy === 'keyId') {
    filters.userId = [];
    filters.keyId = [];
  } else {
    filters[groupBy] = [];
  }
  return {
    range: oneOf(search.get('r'), usageRangeValues, 'today'),
    groupBy,
    filters,
    metric: oneOf(search.get('m'), usageMetricValues, 'total'),
    hidden: (search.get('hide') ?? '').split(',').map(decodeURIComponent).filter(Boolean),
    hiddenSearch: (search.get('hideSearch') ?? '').split(',').map(decodeURIComponent).filter(Boolean),
  };
};

export const serializeUsageUrlState = (state: UsageUrlState): URLSearchParams => {
  const search = new URLSearchParams();
  if (state.range !== 'today') search.set('r', state.range);
  if (state.groupBy !== 'model') search.set('g', state.groupBy);
  if (state.metric !== 'total') search.set('m', state.metric);
  const filters: Array<[string, readonly string[]]> = [
    ['fm', state.filters.model],
    ['fu', state.filters.upstream],
    ['fusr', state.filters.userId],
    ['fk', state.filters.keyId],
  ];
  for (const [key, values] of filters) for (const value of values) search.append(key, value);
  if (state.hidden.length > 0) search.set('hide', state.hidden.map(encodeURIComponent).join(','));
  if (state.hiddenSearch.length > 0) search.set('hideSearch', state.hiddenSearch.map(encodeURIComponent).join(','));
  return search;
};
