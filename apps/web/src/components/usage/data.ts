import type {
  DisplayUsageRecord,
  SearchUsageResponse,
  SearchUsageView,
  UsageFilters,
  UsageGroupBy,
  UsageOverviewResponse,
  UsageRange,
  UsageUpstream,
} from './types';
import { api, callApi } from '../../api/client';
import { dashboardRangeQuery } from '../charts/dashboard-time';
import type {
  SearchUsageByKeyResponse,
  SearchUsageByUserResponse,
  TokenUsageOverviewResponse,
} from '@floway-dev/gateway/control-plane/usage-types';

const userBucketId = (userId: number) => `user-${userId}`;

export const metricsFromWire = (
  metrics: TokenUsageOverviewResponse['series'][number]['metrics'],
): DisplayUsageRecord['metrics'] => Object.fromEntries(
  metrics.map(({ metric, quantity }) => [metric, quantity]),
);

const usageRecordForDisplay = (
  record: TokenUsageOverviewResponse['series'][number],
): DisplayUsageRecord => ({ ...record, metrics: metricsFromWire(record.metrics) });

const usageOverviewForDisplay = (data: TokenUsageOverviewResponse): UsageOverviewResponse => ({
  ...data,
  series: data.series.map(usageRecordForDisplay),
  axes: Object.fromEntries(Object.entries(data.axes).map(([key, records]) => [
    key,
    records.map(usageRecordForDisplay),
  ])) as UsageOverviewResponse['axes'],
});

const searchUsageForDisplay = (data: SearchUsageByKeyResponse | SearchUsageByUserResponse): SearchUsageResponse =>
  data.view === 'all-by-user'
    ? {
        records: data.records.map(({ userId, ...record }) => ({ ...record, keyId: userBucketId(userId) })),
        keys: data.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      }
    : { records: data.records, keys: data.keys };

export const buildUsageOverviewQuery = (
  range: UsageRange,
  groupBy: UsageGroupBy,
  filters: UsageFilters,
  nowMs: number,
): Record<string, string | string[]> => ({
  ...dashboardRangeQuery(range, nowMs),
  bucket: 'hour',
  group_by: groupBy,
  timezone: 'UTC',
  timezone_offset_minutes: '0',
  filter_model: filters.model,
  filter_upstream: filters.upstream,
  filter_user_id: filters.userId,
  filter_key_id: filters.keyId,
});

export const loadUsagePageData = async (
  isAdmin: boolean,
  range: UsageRange,
  groupBy: UsageGroupBy,
  filters: UsageFilters,
  loadedAt: number,
  signal?: AbortSignal,
) => {
  const overviewQuery = buildUsageOverviewQuery(range, groupBy, filters, loadedAt);
  const { start, end } = dashboardRangeQuery(range, loadedAt);
  const searchView: SearchUsageView = isAdmin ? 'all-by-user' : 'self-by-key';
  const searchQuery = searchView === 'all-by-user'
    ? { start, end, include_user_metadata: '1', view: searchView }
    : { start, end, include_key_metadata: '1', view: searchView };
  const [usageResult, searchResult, upstreamsResult] = await Promise.all([
    callApi(() => api.api['token-usage'].overview.$get({ query: overviewQuery }, { init: { signal } })),
    callApi(() => api.api['search-usage'].$get({ query: searchQuery }, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get({}, { init: { signal } })),
  ]);
  const searchData = searchResult.error ? null : searchResult.data;
  if (searchData !== null && (Array.isArray(searchData) || searchData.view !== searchView)) {
    throw new TypeError(`Search usage response does not match the requested ${searchView} view`);
  }
  return {
    usage: usageResult.data ? usageOverviewForDisplay(usageResult.data) : null,
    search: searchData ? searchUsageForDisplay(searchData) : null,
    upstreams: upstreamsResult.data?.map(({ id, name, hue }) => ({ id, name, hue } satisfies UsageUpstream)) ?? [],
    error: usageResult.error ?? searchResult.error ?? upstreamsResult.error ?? null,
  };
};
