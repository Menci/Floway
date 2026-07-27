export type PerformanceView = "all-by-user" | "self-by-key";
export type PerformanceRange = "today" | "7d" | "30d";
export type PerformanceGroupBy = "keyId" | "userId" | "model" | "upstream" | "operation" | "runtimeLocation";
export type PerformanceMetric = "ttft" | "tokPerSec";
export type PerformancePercentile = "p50" | "p95" | "p99";

export interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  ttftSamples: number;
  tpotSamples: number;
  neutral: number;
  ttftMsP50: number | null;
  ttftMsP95: number | null;
  ttftMsP99: number | null;
  tpotUsP50: number | null;
  tpotUsP95: number | null;
  tpotUsP99: number | null;
}

export interface PerformanceFilters {
  model: string;
  upstream: string;
  operation: string;
  runtimeLocation: string;
  userId: string;
  keyId: string;
}

export interface PerformanceUrlState {
  metric: PerformanceMetric;
  percentile: PerformancePercentile;
  groupBy: PerformanceGroupBy;
  range: PerformanceRange;
  filters: PerformanceFilters;
  hidden: string[];
}

export interface PerformanceOverviewResponse {
  series: PerformanceDisplayRecord[];
  axes: Record<PerformanceGroupBy | "none", PerformanceDisplayRecord[]>;
  dimensionValues: {
    models: string[];
    upstreams: string[];
    operations: string[];
    runtimeLocations: string[];
    keyIds: string[];
    userIds: number[];
  };
  users: Array<{ id: number; username: string }>;
  keys: Array<{ id: string; name: string; createdAt: string }>;
}

export const emptyPerformanceOverview = (): PerformanceOverviewResponse => ({
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  keys: [],
});

const pad2 = (value: number): string => String(value).padStart(2, "0");

const local4hBucketStart = (date: Date): Date => {
  const aligned = new Date(date);
  aligned.setMinutes(0, 0, 0);
  aligned.setHours(aligned.getHours() - (aligned.getHours() % 4));
  return aligned;
};

export const performanceRangeQuery = (range: PerformanceRange, nowMs: number) => {
  const now = new Date(nowMs);
  const start = new Date(now);
  if (range === "today") {
    start.setTime(now.getTime() - 23 * 3_600_000);
    start.setMinutes(0, 0, 0);
  } else if (range === "7d") {
    start.setTime(local4hBucketStart(now).getTime() - 41 * 4 * 3_600_000);
  } else {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
  }
  return {
    start: start.toISOString().slice(0, 13),
    end: new Date(now.getTime() + 3_600_000).toISOString().slice(0, 13),
    bucket: range === "today" ? "hour" : range === "7d" ? "4h" : "day",
  } as const;
};

export const buildPerformanceQuery = (
  view: PerformanceView,
  range: PerformanceRange,
  groupBy: PerformanceGroupBy,
  filters: PerformanceFilters,
  nowMs: number,
): URLSearchParams => {
  const window = performanceRangeQuery(range, nowMs);
  const search = new URLSearchParams({
    ...window,
    view,
    group_by: groupBy,
    timezone_offset_minutes: String(new Date(nowMs).getTimezoneOffset()),
  });
  const values: Array<[string, string]> = [
    ["filter_model", filters.model],
    ["filter_upstream", filters.upstream],
    ["filter_operation", filters.operation],
    ["filter_runtime_location", filters.runtimeLocation],
    ["filter_user_id", filters.userId],
    ["filter_key_id", filters.keyId],
  ];
  for (const [key, value] of values) if (value) search.set(key, value);
  return search;
};

export const performanceValue = (
  record: PerformanceDisplayRecord,
  metric: PerformanceMetric,
  percentile: PerformancePercentile,
): number | null => {
  if (metric === "ttft") {
    return percentile === "p50" ? record.ttftMsP50 : percentile === "p95" ? record.ttftMsP95 : record.ttftMsP99;
  }
  const us = percentile === "p50" ? record.tpotUsP50 : percentile === "p95" ? record.tpotUsP95 : record.tpotUsP99;
  return us === null || us <= 0 ? null : 1_000_000 / us;
};

export const resolvePerformanceGroup = (
  group: string,
  groupBy: PerformanceGroupBy,
  overview: PerformanceOverviewResponse,
  upstreamNames: ReadonlyMap<string, string>,
): string => {
  if (groupBy === "upstream") return upstreamNames.get(group) ?? group;
  if (groupBy === "userId") return overview.users.find((user) => String(user.id) === group)?.username ?? `user ${group}`;
  if (groupBy === "keyId") return overview.keys.find((key) => key.id === group)?.name ?? group;
  return group;
};

export const emptyPerformanceFilters = (): PerformanceFilters => ({
  model: "", upstream: "", operation: "", runtimeLocation: "", userId: "", keyId: "",
});

const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  value !== null && (allowed as readonly string[]).includes(value) ? value as T : fallback;

export const parsePerformanceUrlState = (search: URLSearchParams): PerformanceUrlState => ({
  metric: oneOf(search.get("m"), ["ttft", "tokPerSec"], "ttft"),
  percentile: oneOf(search.get("pct"), ["p50", "p95", "p99"], "p95"),
  groupBy: oneOf(search.get("g"), ["model", "upstream", "operation", "runtimeLocation", "keyId", "userId"], "model"),
  range: oneOf(search.get("r"), ["today", "7d", "30d"], "today"),
  filters: {
    model: search.get("fm") ?? "", upstream: search.get("fu") ?? "", operation: search.get("fo") ?? "",
    runtimeLocation: search.get("fr") ?? "", userId: search.get("fusr") ?? "", keyId: search.get("fk") ?? "",
  },
  hidden: (search.get("hide") ?? "").split(",").map(decodeURIComponent).filter(Boolean),
});

export const serializePerformanceUrlState = (state: PerformanceUrlState): URLSearchParams => {
  const search = new URLSearchParams();
  if (state.metric !== "ttft") search.set("m", state.metric);
  if (state.percentile !== "p95") search.set("pct", state.percentile);
  if (state.groupBy !== "model") search.set("g", state.groupBy);
  if (state.range !== "today") search.set("r", state.range);
  const filters: Array<[string, string]> = [["fm", state.filters.model], ["fu", state.filters.upstream], ["fo", state.filters.operation], ["fr", state.filters.runtimeLocation], ["fusr", state.filters.userId], ["fk", state.filters.keyId]];
  for (const [key, value] of filters) if (value) search.set(key, value);
  if (state.hidden.length) search.set("hide", state.hidden.map(encodeURIComponent).join(","));
  return search;
};

export const clearGroupedFilter = (filters: PerformanceFilters, groupBy: PerformanceGroupBy): PerformanceFilters => ({
  ...filters,
  ...(groupBy === "model" ? { model: "" } : {}),
  ...(groupBy === "upstream" ? { upstream: "" } : {}),
  ...(groupBy === "operation" ? { operation: "" } : {}),
  ...(groupBy === "runtimeLocation" ? { runtimeLocation: "" } : {}),
  ...(groupBy === "userId" || groupBy === "keyId" ? { userId: "", keyId: "" } : {}),
});
