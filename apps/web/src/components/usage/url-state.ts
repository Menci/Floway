import type { UsageFilters, UsageGroupBy, UsageMetric, UsageRange } from './types';
import { oneOf, repeatedValues } from '../../lib/search-params';
import { clearGroupedTelemetryFilters } from '../telemetry/filter-state';
import { parseHiddenSeries, serializeHiddenSeries } from '../telemetry/hidden-series-url';

export interface UsageUrlState {
  range: UsageRange;
  groupBy: UsageGroupBy;
  filters: UsageFilters;
  metric: UsageMetric;
  hidden: string[];
  hiddenSearch: string[];
}

const usageRangeValues: UsageRange[] = ['today', '7d', '30d'];
const usageMetricValues: UsageMetric[] = ['requests', 'cost', 'total', 'input', 'output', 'prefill', 'cached', 'cachedRate', 'cacheCreation'];
const usageGroupByValues: UsageGroupBy[] = ['model', 'upstream', 'keyId', 'userId'];

export const parseUsageUrlState = (search: URLSearchParams): UsageUrlState => {
  const groupBy = oneOf(search.get('g'), usageGroupByValues, 'model');
  const filters: UsageFilters = {
    model: repeatedValues(search, 'fm'),
    upstream: repeatedValues(search, 'fu'),
    userId: repeatedValues(search, 'fusr'),
    keyId: repeatedValues(search, 'fk'),
  };
  return {
    range: oneOf(search.get('r'), usageRangeValues, 'today'),
    groupBy,
    filters: clearGroupedTelemetryFilters(filters, groupBy),
    metric: oneOf(search.get('m'), usageMetricValues, 'total'),
    hidden: parseHiddenSeries(search, 'hide'),
    hiddenSearch: parseHiddenSeries(search, 'hideSearch'),
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
  serializeHiddenSeries(search, 'hide', state.hidden);
  serializeHiddenSeries(search, 'hideSearch', state.hiddenSearch);
  return search;
};
