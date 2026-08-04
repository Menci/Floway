import type { UsageFilters, UsageGroupBy, UsageMetric, UsageRange, UsageView } from './types';
import { oneOf, repeatedValues } from '../../lib/search-params';

export interface UsageUrlState {
  view: UsageView;
  range: UsageRange;
  groupBy: UsageGroupBy;
  filters: UsageFilters;
  metric: UsageMetric;
  redactKeys: boolean;
  hiddenKeys: string[];
  hiddenModels: string[];
  hiddenUpstreams: string[];
}

const usageViewValues: UsageView[] = ['all-by-user', 'self-by-key'];
const usageRangeValues: UsageRange[] = ['today', '7d', '30d'];
const usageMetricValues: UsageMetric[] = ['requests', 'cost', 'total', 'input', 'output', 'prefill', 'cached', 'cachedRate', 'cacheCreation', 'cacheHitRate'];
const usageGroupByValues: UsageGroupBy[] = ['identity', 'model', 'upstream'];

export const parseUsageUrlState = (search: URLSearchParams): UsageUrlState => ({
  view: oneOf(search.get('view'), usageViewValues, 'all-by-user'),
  range: oneOf(search.get('range'), usageRangeValues, 'today'),
  groupBy: oneOf(search.get('group'), usageGroupByValues, 'identity'),
  filters: {
    identity: repeatedValues(search, 'filterKey'),
    model: repeatedValues(search, 'filterModel'),
    upstream: repeatedValues(search, 'filterUpstream'),
  },
  metric: oneOf(search.get('metric'), usageMetricValues, 'total'),
  redactKeys: search.get('redact') === '1',
  hiddenKeys: search.getAll('hideKey'),
  hiddenModels: search.getAll('hideModel'),
  hiddenUpstreams: search.getAll('hideUpstream'),
});

export const serializeUsageUrlState = (state: UsageUrlState): URLSearchParams => {
  const search = new URLSearchParams({ view: state.view, range: state.range, metric: state.metric });
  if (state.groupBy !== 'identity') search.set('group', state.groupBy);
  if (state.redactKeys) search.set('redact', '1');
  for (const id of [...state.hiddenKeys].sort()) search.append('hideKey', id);
  for (const id of [...state.hiddenModels].sort()) search.append('hideModel', id);
  for (const id of [...state.hiddenUpstreams].sort()) search.append('hideUpstream', id);
  for (const id of [...state.filters.identity].sort()) search.append('filterKey', id);
  for (const id of [...state.filters.model].sort()) search.append('filterModel', id);
  for (const id of [...state.filters.upstream].sort()) search.append('filterUpstream', id);
  return search;
};
