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
export const emptySearchUsageResponse = (): SearchUsageResponse => ({ records: [], keys: [], activeProvider: 'disabled' });
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
    const usageData = usageRes.data && !Array.isArray(usageRes.data) && usageRes.data.view === 'all-by-user'
      ? usageRes.data
      : undefined;
    const searchData = searchRes.data && !Array.isArray(searchRes.data) && searchRes.data.view === 'all-by-user'
      ? searchRes.data
      : undefined;
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
        activeProvider: searchData.activeProvider,
      } : emptySearchUsageResponse(),
      error: usageRes.error?.message ?? searchRes.error?.message ?? null,
    };
  }
  const [usageRes, searchRes] = await Promise.all([
    callApi(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
    callApi(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
  ]);
  const usageData = usageRes.data && !Array.isArray(usageRes.data) && usageRes.data.view === 'self-by-key'
    ? usageRes.data
    : undefined;
  const searchData = searchRes.data && !Array.isArray(searchRes.data) && searchRes.data.view === 'self-by-key'
    ? searchRes.data
    : undefined;
  return {
    usage: usageData ? {
      records: usageData.records.map(record => ({ ...record, metrics: metricsFromWire(record.metrics) })),
      keys: usageData.keys,
    } : emptyUsageResponse(),
    search: searchData ?? emptySearchUsageResponse(),
    error: usageRes.error?.message ?? searchRes.error?.message ?? null,
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
