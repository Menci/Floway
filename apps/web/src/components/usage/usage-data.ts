import type {
  DisplayUsageRecord,
  UsageRange,
  UsageView,
} from './types';
import { api, callApi } from '../../api/client';
import { dashboardRangeQuery } from '../charts/dashboard-time';
import type {
  TokenUsageByKeyResponse,
} from '@floway-dev/gateway/control-plane/usage-types';

const userBucketId = (userId: number) => `user-${userId}`;

export const metricsFromWire = (
  metrics: TokenUsageByKeyResponse['records'][number]['metrics'],
): DisplayUsageRecord['metrics'] => Object.fromEntries(
  metrics.map(({ metric, quantity }) => [metric, quantity]),
);

// `null` on failure: a failed fetch did not report zero usage, and a zeroed
// chart beside a dismissible bar reads as a quiet gateway.
const fetchUsageForView = async (view: UsageView, start: string, end: string, signal?: AbortSignal) => {
  if (view === 'all-by-user') {
    const [usageRes, searchRes] = await Promise.all([
      callApi(() => api.api['token-usage'].$get({ query: { start, end, include_user_metadata: '1', view } }, { init: { signal } })),
      callApi(() => api.api['search-usage'].$get({ query: { start, end, include_user_metadata: '1', view } }, { init: { signal } })),
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
      } : null,
      search: searchData ? {
        records: searchData.records.map(({ userId, ...record }) => ({ ...record, keyId: userBucketId(userId) })),
        keys: searchData.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      } : null,
      error: usageRes.error ?? searchRes.error ?? null,
    };
  }
  const [usageRes, searchRes] = await Promise.all([
    callApi(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1', view } }, { init: { signal } })),
    callApi(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1', view } }, { init: { signal } })),
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
    } : null,
    search: searchData ? { records: searchData.records, keys: searchData.keys } : null,
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
