import { dashboardRangeQuery } from '../charts/dashboard-time';
import type {
  DisplayUsageRecord,
  SearchUsageResponse,
  UsageRange,
  UsageResponse,
  UsageView,
} from './types';
import { callApi } from '../../api/auth';
import { api } from '../../api/client';

interface UsageByUserResponse {
  records: Array<{ userId: number; model: string; hour: string; requests: number; metrics: DisplayUsageRecord['metrics']; cost: DisplayUsageRecord['cost'] }>;
  users: Array<{ id: number; username: string }>;
}
interface SearchUsageByUserResponse {
  records: Array<{ provider: string; userId: number; hour: string; requests: number }>;
  users: Array<{ id: number; username: string }>;
  activeProvider: string;
}

export const emptyUsageResponse = (): UsageResponse => ({ records: [], keys: [] });
export const emptySearchUsageResponse = (): SearchUsageResponse => ({ records: [], keys: [], activeProvider: 'disabled' });
const userBucketId = (userId: number) => `user-${userId}`;

async function fetchUsageForView(view: UsageView, start: string, end: string) {
  if (view === 'all-by-user') {
    const [usageRes, searchRes] = await Promise.all([
      callApi(() => api.api['token-usage'].$get({ query: { start, end, include_user_metadata: '1', view } })),
      callApi(() => api.api['search-usage'].$get({ query: { start, end, include_user_metadata: '1', view } })),
    ]);
    return {
      usage: usageRes.data ? {
        records: usageRes.data.records.map(record => ({ ...record, keyId: userBucketId(record.userId), userId: undefined })),
        keys: usageRes.data.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      } as UsageResponse : emptyUsageResponse(),
      search: searchRes.data ? {
        records: searchRes.data.records.map(record => ({ ...record, keyId: userBucketId(record.userId), userId: undefined })),
        keys: searchRes.data.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
        activeProvider: searchRes.data.activeProvider,
      } as SearchUsageResponse : emptySearchUsageResponse(),
      error: usageRes.error?.message ?? searchRes.error?.message ?? null,
    };
  }
  const [usageRes, searchRes] = await Promise.all([
    callApi(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
    callApi(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
  ]);
  return {
    usage: usageRes.data ?? emptyUsageResponse(),
    search: searchRes.data ?? emptySearchUsageResponse(),
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
