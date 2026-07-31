import type {
  DisplayUsageRecord,
  SearchUsageResponse,
  UsageRange,
  UsageResponse,
  UsageView,
} from './types';
import { callApi } from '../../api/auth';
import { api } from '../../api/client';
import { dashboardRangeQuery } from '../charts/dashboard-time';
import type {
  TokenUsageByKeyResponse,
} from '@floway-dev/gateway/control-plane/usage-types';

export const emptyUsageResponse = (): UsageResponse => ({ records: [], keys: [] });
export const emptySearchUsageResponse = (): SearchUsageResponse => ({ records: [], keys: [] });
const userBucketId = (userId: number) => `user-${userId}`;

export const metricsFromWire = (
  metrics: TokenUsageByKeyResponse['records'][number]['metrics'],
): DisplayUsageRecord['metrics'] => Object.fromEntries(
  metrics.map(({ metric, quantity }) => [metric, quantity]),
);

async function fetchUsageForView(view: UsageView, start: string, end: string) {
  if (view === 'all-by-user') {
    const [usageRes, searchRes] = await Promise.all([
      callApi(() => api.api['token-usage'].$get({ query: { start, end, include_user_metadata: '1', view } })),
      callApi(() => api.api['search-usage'].$get({ query: { start, end, include_user_metadata: '1', view } })),
    ]);
    const usageData = usageRes.error ? null : usageRes.data;
    const searchData = searchRes.error ? null : searchRes.data;
    if (usageData !== null && (Array.isArray(usageData) || usageData.view !== 'all-by-user')) {
      throw new TypeError('Token usage response does not match the requested all-by-user view');
    }
    if (searchData !== null && (Array.isArray(searchData) || searchData.view !== 'all-by-user')) {
      throw new TypeError('Search usage response does not match the requested all-by-user view');
    }
    return {
      usage: usageData ? {
        records: usageData.records.map(({ userId, ...record }) => ({
          ...record,
          keyId: userBucketId(userId),
          metrics: metricsFromWire(record.metrics),
        })),
        keys: usageData.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      } : emptyUsageResponse(),
      search: searchData ? {
        records: searchData.records.map(({ userId, ...record }) => ({ ...record, keyId: userBucketId(userId) })),
        keys: searchData.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      } : emptySearchUsageResponse(),
      error: usageRes.error ?? searchRes.error ?? null,
    };
  }
  const [usageRes, searchRes] = await Promise.all([
    callApi(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
    callApi(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
  ]);
  const usageData = usageRes.error ? null : usageRes.data;
  const searchData = searchRes.error ? null : searchRes.data;
  if (usageData !== null && (Array.isArray(usageData) || usageData.view !== 'self-by-key')) {
    throw new TypeError('Token usage response does not match the requested self-by-key view');
  }
  if (searchData !== null && (Array.isArray(searchData) || searchData.view !== 'self-by-key')) {
    throw new TypeError('Search usage response does not match the requested self-by-key view');
  }
  return {
    usage: usageData ? {
      records: usageData.records.map(record => ({ ...record, metrics: metricsFromWire(record.metrics) })),
      keys: usageData.keys,
    } : emptyUsageResponse(),
    search: searchData ? { records: searchData.records, keys: searchData.keys } : emptySearchUsageResponse(),
    error: usageRes.error ?? searchRes.error ?? null,
  };
}

export async function loadUsagePageData(
  view: UsageView,
  range: UsageRange,
  loadedAt: number,
) {
  const { start, end } = dashboardRangeQuery(range, loadedAt);
  const [usageData, modelsResult] = await Promise.all([
    fetchUsageForView(view, start, end),
    callApi(() => api.api.models.$get({ query: {} })),
  ]);
  return { ...usageData, models: modelsResult.data?.data ?? [] };
}
