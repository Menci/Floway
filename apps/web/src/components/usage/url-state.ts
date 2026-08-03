import type { UsageMetric, UsageRange, UsageView } from './types';
import { oneOf } from '../../lib/search-params';

export interface UsageUrlState {
  view: UsageView;
  range: UsageRange;
  metric: UsageMetric;
  redactKeys: boolean;
  hiddenKeys: string[];
  hiddenModels: string[];
}

const usageViewValues: UsageView[] = ['all-by-user', 'self-by-key'];
const usageRangeValues: UsageRange[] = ['today', '7d', '30d'];
const usageMetricValues: UsageMetric[] = ['requests', 'cost', 'total', 'input', 'output', 'prefill', 'cached', 'cachedRate', 'cacheCreation', 'cacheHitRate'];

export const parseUsageUrlState = (search: URLSearchParams): UsageUrlState => ({
  view: oneOf(search.get('view'), usageViewValues, 'all-by-user'),
  range: oneOf(search.get('range'), usageRangeValues, 'today'),
  metric: oneOf(search.get('metric'), usageMetricValues, 'total'),
  redactKeys: search.get('redact') === '1',
  hiddenKeys: search.getAll('hideKey'),
  hiddenModels: search.getAll('hideModel'),
});

export const serializeUsageUrlState = (state: UsageUrlState): URLSearchParams => {
  const search = new URLSearchParams({ view: state.view, range: state.range, metric: state.metric });
  if (state.redactKeys) search.set('redact', '1');
  for (const id of [...state.hiddenKeys].sort()) search.append('hideKey', id);
  for (const id of [...state.hiddenModels].sort()) search.append('hideModel', id);
  return search;
};
