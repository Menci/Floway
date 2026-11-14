import type {
  DisplayUsageRecord,
  SearchUsageResponse,
  SearchUsageView,
  UsageFilters,
  UsageGroupBy,
  UsageOverviewResponse,
  UsageRange,
} from './types';
import { api, callApi, type ApiResult } from '../../api/client';
import { dashboardRangeQuery } from '../charts/dashboard-time';
import type {
  SearchUsageByKeyResponse,
  SearchUsageByUserResponse,
  TokenUsageOverviewResponse,
} from '@floway-dev/gateway/browser';

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
  group_by: groupBy,
  filter_model: filters.model,
  filter_upstream: filters.upstream,
  filter_user_id: filters.userId,
  filter_key_id: filters.keyId,
});

export const loadUsageOverview = async (range: UsageRange, groupBy: UsageGroupBy, filters: UsageFilters, loadedAt: number, signal?: AbortSignal): Promise<ApiResult<UsageOverviewResponse>> => {
  const query = buildUsageOverviewQuery(range, groupBy, filters, loadedAt);
  const result = await callApi(() => api.api['token-usage'].overview.$get({ query }, { init: { signal } }));
  return result.error ? result : { data: usageOverviewForDisplay(result.data) };
};

export const loadUsagePageData = async (
  currentUserId: string,
  range: UsageRange,
  groupBy: UsageGroupBy,
  filters: UsageFilters,
  loadedAt: number,
  signal?: AbortSignal,
  knownAuditableUserIds?: readonly number[],
) => {
  const { start, end } = dashboardRangeQuery(range, loadedAt);
  const searchViewFor = (ids: readonly number[] | undefined): SearchUsageView => ids?.some(id => String(id) !== currentUserId)
    ? 'all-by-user'
    : 'self-by-key';
  const loadSearch = (view: SearchUsageView) => callApi(() => api.api['search-usage'].$get({
    query: view === 'all-by-user'
      ? { start, end, include_user_metadata: '1', view }
      : { start, end, include_key_metadata: '1', view },
  }, { init: { signal } }));
  let searchView = searchViewFor(knownAuditableUserIds);
  let usageResult;
  let searchResult;
  if (knownAuditableUserIds === undefined) {
    usageResult = await loadUsageOverview(range, groupBy, filters, loadedAt, signal);
    searchView = searchViewFor(usageResult.data?.auditableUserIds);
    searchResult = await loadSearch(searchView);
  } else {
    [usageResult, searchResult] = await Promise.all([
      loadUsageOverview(range, groupBy, filters, loadedAt, signal),
      loadSearch(searchView),
    ]);
    const currentSearchView = usageResult.data === undefined ? searchView : searchViewFor(usageResult.data.auditableUserIds);
    if (!signal?.aborted && currentSearchView !== searchView) {
      searchView = currentSearchView;
      searchResult = await loadSearch(searchView);
    }
  }
  const searchData = searchResult.error ? null : searchResult.data;
  if (searchData !== null && (Array.isArray(searchData) || searchData.view !== searchView)) {
    throw new TypeError(`Search usage response does not match the requested ${searchView} view`);
  }
  return {
    usage: usageResult.data ?? null,
    search: searchData ? searchUsageForDisplay(searchData) : null,
    upstreams: usageResult.data?.upstreams ?? [],
    error: usageResult.error ?? searchResult.error ?? null,
  };
};
