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
    const usageData = usageRes.data as UsageByUserResponse | undefined;
    const searchData = searchRes.data as SearchUsageByUserResponse | undefined;
    return {
      usage: usageData ? {
        records: usageData.records.map(record => ({ ...record, keyId: userBucketId(record.userId), userId: undefined })),
        keys: usageData.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
      } as UsageResponse : emptyUsageResponse(),
      search: searchData ? {
        records: searchData.records.map(record => ({ ...record, keyId: userBucketId(record.userId), userId: undefined })),
        keys: searchData.users.map(user => ({ id: userBucketId(user.id), name: user.username })),
        activeProvider: searchData.activeProvider,
      } as SearchUsageResponse : emptySearchUsageResponse(),
      error: usageRes.error?.message ?? searchRes.error?.message ?? null,
    };
  }
  const [usageRes, searchRes] = await Promise.all([
    callApi(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
    callApi(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1', view } })),
  ]);
  return {
    usage: usageRes.data as UsageResponse | undefined ?? emptyUsageResponse(),
    search: searchRes.data as SearchUsageResponse | undefined ?? emptySearchUsageResponse(),
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
