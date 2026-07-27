import type { AuthUser } from "../../api/auth";
import { authFetch, callApi } from "../../api/auth";
import type { ControlPlaneModel } from "../../api/types";
import type {
  DisplayUsageRecord,
  SearchUsageResponse,
  UsageRange,
  UsageResponse,
  UsageView,
} from "./types";
import { dashboardRangeQuery } from "./chart-model";

interface UsageByUserResponse {
  records: Array<{ userId: number; model: string; hour: string; requests: number; tokens: DisplayUsageRecord["tokens"]; cost: number }>;
  users: Array<{ id: number; username: string }>;
}
interface SearchUsageByUserResponse {
  records: Array<{ provider: string; userId: number; hour: string; requests: number }>;
  users: Array<{ id: number; username: string }>;
  activeProvider: string;
}
interface ModelsResponse { object: string; data: ControlPlaneModel[] }

export const emptyUsageResponse = (): UsageResponse => ({ records: [], keys: [] });
export const emptySearchUsageResponse = (): SearchUsageResponse => ({ records: [], keys: [], activeProvider: "disabled" });
const userBucketId = (userId: number) => `user-${userId}`;

const requestJson = <T,>(path: string, query?: Record<string, string>) => {
  const search = new URLSearchParams(query);
  return callApi<T>(() => authFetch(search.size ? `${path}?${search}` : path));
};

async function fetchUsageForView(view: UsageView, start: string, end: string) {
  if (view === "all-by-user") {
    const [usageRes, searchRes] = await Promise.all([
      requestJson<UsageByUserResponse>("/api/token-usage", { start, end, include_user_metadata: "1", view }),
      requestJson<SearchUsageByUserResponse>("/api/search-usage", { start, end, include_user_metadata: "1", view }),
    ]);
    return {
      usage: usageRes.data ? {
        records: usageRes.data.records.map((record) => ({ ...record, keyId: userBucketId(record.userId), userId: undefined })),
        keys: usageRes.data.users.map((user) => ({ id: userBucketId(user.id), name: user.username })),
      } as UsageResponse : emptyUsageResponse(),
      search: searchRes.data ? {
        records: searchRes.data.records.map((record) => ({ ...record, keyId: userBucketId(record.userId), userId: undefined })),
        keys: searchRes.data.users.map((user) => ({ id: userBucketId(user.id), name: user.username })),
        activeProvider: searchRes.data.activeProvider,
      } as SearchUsageResponse : emptySearchUsageResponse(),
      error: usageRes.error?.message ?? searchRes.error?.message ?? null,
    };
  }
  const [usageRes, searchRes] = await Promise.all([
    requestJson<UsageResponse>("/api/token-usage", { start, end, include_key_metadata: "1", view }),
    requestJson<SearchUsageResponse>("/api/search-usage", { start, end, include_key_metadata: "1", view }),
  ]);
  return {
    usage: usageRes.data ?? emptyUsageResponse(),
    search: searchRes.data ?? emptySearchUsageResponse(),
    error: usageRes.error?.message ?? searchRes.error?.message ?? null,
  };
}

export async function loadUsagePageData(
  _user: AuthUser,
  view: UsageView,
  range: UsageRange,
  loadedAt: number,
) {
  const { start, end } = dashboardRangeQuery(range, loadedAt);
  const [usageData, modelsResult] = await Promise.all([
    fetchUsageForView(view, start, end),
    requestJson<ModelsResponse>("/api/models"),
  ]);
  return { ...usageData, models: modelsResult.data?.data ?? [] };
}
