import { usageOverviewForDisplay } from './overview';
import type {
  SearchUsageResponse,
  SearchUsageView,
  UsageFilters,
  UsageGroupBy,
  UsageOverviewResponse,
  UsageRange,
} from './types';
import { api, callApi, type ApiResult } from '../../api/client';
import { dashboardFixedRangeQuery } from '../charts/dashboard-time';
import { canContinueTelemetrySnapshot, mergeTelemetrySnapshot, sameTelemetryBucketGrid, sameTelemetryScope } from '../telemetry/snapshot';
import type {
  SearchUsageByKeyResponse,
  SearchUsageByUserResponse,
  TokenUsageOverviewResponse,
} from '@floway-dev/gateway/browser';

const userBucketId = (userId: number) => `user-${userId}`;

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
) => ({
  ...dashboardFixedRangeQuery(range, nowMs),
  format: 'fixed-buckets' as const,
  group_by: groupBy,
  filter_model: filters.model,
  filter_upstream: filters.upstream,
  filter_user_id: filters.userId,
  filter_key_id: filters.keyId,
});

export type UsageOverviewLoader = (
  range: UsageRange, groupBy: UsageGroupBy, filters: UsageFilters, loadedAt: number,
  signal: AbortSignal,
) => Promise<ApiResult<UsageOverviewResponse>>;

type UsageOverviewQuery = ReturnType<typeof buildUsageOverviewQuery>;

const sameMembers = <T>(left: readonly T[], right: readonly T[]): boolean => {
  const members = new Set(left);
  return members.size === new Set(right).size && right.every(value => members.has(value));
};

const sameUsageQuery = (left: UsageOverviewQuery, right: UsageOverviewQuery): boolean =>
  sameTelemetryBucketGrid(left, right)
  && (left.group_by === 'keyId') === (right.group_by === 'keyId')
  && sameMembers(left.filter_model, right.filter_model)
  && sameMembers(left.filter_upstream, right.filter_upstream)
  && sameMembers(left.filter_user_id, right.filter_user_id)
  && sameMembers(left.filter_key_id, right.filter_key_id);

export const createUsageOverviewLoader = (): UsageOverviewLoader => {
  let latest: { query: UsageOverviewQuery; snapshot: TokenUsageOverviewResponse } | undefined;
  return async (range, groupBy, filters, loadedAt, signal) => {
    const query = buildUsageOverviewQuery(range, groupBy, filters, loadedAt);
    let previous = latest && sameUsageQuery(latest.query, query) ? latest.snapshot : undefined;
    const cursor = canContinueTelemetrySnapshot(previous, query) ? previous.cursor : undefined;
    const load = (cursor: string | undefined) => callApi(() => api.api['token-usage'].overview.$get({ query: cursor === undefined ? query : { ...query, cursor } }, { init: { signal } }));
    let result = await load(cursor);
    if (result.error) return result;
    if (previous && !result.data.reset && !sameTelemetryScope(previous.scope, result.data.scope)) {
      previous = undefined;
      if (!signal.aborted) latest = undefined;
      result = await load(undefined);
      if (result.error) return result;
    }
    const snapshot = mergeTelemetrySnapshot(previous, result.data, query.start);
    const data = usageOverviewForDisplay(snapshot, groupBy);
    if (!signal.aborted) latest = { query, snapshot };
    return { data };
  };
};

export const loadUsagePageData = async (
  loadUsageOverview: UsageOverviewLoader,
  currentUserId: string,
  range: UsageRange,
  groupBy: UsageGroupBy,
  filters: UsageFilters,
  loadedAt: number,
  signal: AbortSignal,
  knownAuditableUserIds?: readonly number[],
) => {
  const { start, end } = dashboardFixedRangeQuery(range, loadedAt);
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
    if (!signal.aborted && currentSearchView !== searchView) {
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
