import type {
  DisplayUsageRecord,
  SearchUsageResponse,
  UsageRange,
  UsageResponse,
  UsageView,
} from './types';
import { api, callApi, type ApiResult } from '../../api/client';
import { dashboardRangeQuery } from '../charts/dashboard-time';
import type {
  SearchUsageByKeyResponse,
  SearchUsageByUserResponse,
  TokenUsageByKeyResponse,
  TokenUsageByUserResponse,
} from '@floway-dev/gateway/control-plane/usage-types';

const userBucketId = (userId: number) => `user-${userId}`;

export const metricsFromWire = (
  metrics: TokenUsageByKeyResponse['records'][number]['metrics'],
): DisplayUsageRecord['metrics'] => Object.fromEntries(
  metrics.map(({ metric, quantity }) => [metric, quantity]),
);

// `null` on failure: a failed fetch did not report zero usage, and a zeroed
// chart beside a dismissible bar reads as a quiet gateway. A body in the other
// view's shape is a broken contract rather than something to render around.
const forRequestedView = <T extends { view: UsageView }>(
  result: ApiResult<T | unknown[], unknown>,
  view: UsageView,
  what: string,
): T | null => {
  if (result.error) return null;
  const data = result.data;
  if (Array.isArray(data) || data.view !== view) {
    throw new TypeError(`${what} response does not match the requested ${view} view`);
  }
  return data;
};

const tokenUsageForDisplay = (data: TokenUsageByKeyResponse | TokenUsageByUserResponse): UsageResponse =>
  data.view === 'all-by-user'
    ? {
        records: data.records.map(({ userId, ...record }) => ({
          ...record,
          keyId: userBucketId(userId),
          metrics: metricsFromWire(record.metrics),
        })),
        keys: data.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      }
    : {
        records: data.records.map(record => ({ ...record, metrics: metricsFromWire(record.metrics) })),
        keys: data.keys,
      };

const searchUsageForDisplay = (data: SearchUsageByKeyResponse | SearchUsageByUserResponse): SearchUsageResponse =>
  data.view === 'all-by-user'
    ? {
        records: data.records.map(({ userId, ...record }) => ({ ...record, keyId: userBucketId(userId) })),
        keys: data.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      }
    : { records: data.records, keys: data.keys };

const fetchUsageForView = async (view: UsageView, start: string, end: string, signal?: AbortSignal) => {
  // The views differ only in which metadata the gateway joins in and in how a
  // record names its bucket on the way out.
  const query = view === 'all-by-user'
    ? { start, end, include_user_metadata: '1', view }
    : { start, end, include_key_metadata: '1', view };
  const [usageRes, searchRes] = await Promise.all([
    callApi(() => api.api['token-usage'].$get({ query }, { init: { signal } })),
    callApi(() => api.api['search-usage'].$get({ query }, { init: { signal } })),
  ]);
  const usageData = forRequestedView<TokenUsageByKeyResponse | TokenUsageByUserResponse>(usageRes, view, 'Token usage');
  const searchData = forRequestedView<SearchUsageByKeyResponse | SearchUsageByUserResponse>(searchRes, view, 'Search usage');
  return {
    usage: usageData && tokenUsageForDisplay(usageData),
    search: searchData && searchUsageForDisplay(searchData),
    error: usageRes.error ?? searchRes.error ?? null,
  };
};

export const loadUsagePageData = async (
  view: UsageView,
  range: UsageRange,
  loadedAt: number,
  signal?: AbortSignal,
) => {
  const { start, end } = dashboardRangeQuery(range, loadedAt);
  const [usageData, modelsResult] = await Promise.all([
    fetchUsageForView(view, start, end, signal),
    callApi(() => api.api.models.$get({ query: {} }, { init: { signal } })),
  ]);
  return {
    ...usageData,
    models: modelsResult.data?.data ?? null,
    error: usageData.error ?? modelsResult.error ?? null,
  };
};
