import type {
  DisplayUsageRecord,
  SearchUsageResponse,
  UsageRange,
  UsageResponse,
  UsageUpstream,
  UsageView,
} from './types';
import { api, callApi, type ApiResult } from '../../api/client';
import { dashboardRangeQuery } from '../charts/dashboard-time';
import type {
  DashboardTokenUsageByKeyResponse,
  DashboardTokenUsageByUserResponse,
  SearchUsageByKeyResponse,
  SearchUsageByUserResponse,
} from '@floway-dev/gateway/control-plane/usage-types';

const userBucketId = (userId: number) => `user-${userId}`;

export const metricsFromWire = (
  metrics: DashboardTokenUsageByKeyResponse['records'][number]['metrics'],
): DisplayUsageRecord['metrics'] => Object.fromEntries(
  metrics.map(({ metric, quantity }) => [metric, quantity]),
);

// `null` on failure: a failed fetch did not report zero usage, and a zeroed
// chart beside a dismissible bar reads as a quiet gateway. A body in the other
// view's shape is a broken contract rather than something to render around.
interface UsageViewEnvelope {
  view: UsageView;
  dimensions?: unknown;
}

const forRequestedView = <T extends { view: UsageView }>(
  result: ApiResult<UsageViewEnvelope | unknown[], unknown>,
  view: UsageView,
  what: string,
  accepts: (data: UsageViewEnvelope) => boolean = () => true,
): T | null => {
  if (result.error) return null;
  const data = result.data;
  if (Array.isArray(data) || data.view !== view || !accepts(data)) {
    throw new TypeError(`${what} response does not match the requested ${view} view`);
  }
  return data as T;
};

const tokenUsageForDisplay = (data: DashboardTokenUsageByKeyResponse | DashboardTokenUsageByUserResponse): UsageResponse =>
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
    callApi(() => api.api['token-usage'].$get({ query: { ...query, include_upstream_dimension: '1' } }, { init: { signal } })),
    callApi(() => api.api['search-usage'].$get({ query }, { init: { signal } })),
  ]);
  const usageData = forRequestedView<DashboardTokenUsageByKeyResponse | DashboardTokenUsageByUserResponse>(
    usageRes,
    view,
    'Token usage',
    data => Array.isArray(data.dimensions) && data.dimensions.length === 1 && data.dimensions[0] === 'upstream',
  );
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
  const [usageData, modelsResult, upstreamsResult] = await Promise.all([
    fetchUsageForView(view, start, end, signal),
    callApi(() => api.api.models.$get({ query: {} }, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get({}, { init: { signal } })),
  ]);
  return {
    ...usageData,
    models: modelsResult.data?.data ?? null,
    upstreams: upstreamsResult.data?.map(({ id, name }) => ({ id, name } satisfies UsageUpstream)) ?? [],
    error: usageData.error ?? modelsResult.error ?? upstreamsResult.error ?? null,
  };
};
