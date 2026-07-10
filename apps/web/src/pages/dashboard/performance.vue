<script lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core';
import type { TooltipItem } from 'chart.js';
import type { ChartConfiguration } from 'chart.js/auto';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, shallowRef, watch, watchEffect } from 'vue';
import { useRoute, useRouter, type LocationQuery, type LocationQueryValue } from 'vue-router';

import { callApi, useApi } from '../../api/client.ts';
import ChartCanvas from '../../components/charts/ChartCanvas.vue';
import ChartSeriesControls from '../../components/charts/ChartSeriesControls.vue';
import { chartColor, chartColorByName, chartFont, chartXAxisTick, dashboardBuckets, dashboardRangeQuery, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import { applySeriesSelection, chartEventsWithDoubleClick, chartSeriesIds, createSeriesIsolation, handleLegendClick } from '../../components/charts/series-selection.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { useAuthStore } from '../../stores/auth.ts';
import type { PerformanceDisplayRecord } from '@floway-dev/gateway/control-plane/performance/aggregate';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

type PerformanceView = 'all-by-user' | 'self-by-key';
type GroupBy = 'keyId' | 'userId' | 'model' | 'upstream' | 'operation' | 'runtimeLocation';
type MetricView = 'ttft' | 'tokPerSec';
type PercentileKey = 'p50' | 'p95' | 'p99';
type TableSortKey = 'group' | 'requests' | 'errors' | 'ttftMsP95' | 'tpotUsP95';
type SortDir = 'asc' | 'desc';

// PerformanceDisplayRecord + the human label resolved once at sort time so
// the template never re-invokes resolveGroupName per render tick.
interface DisplayRow extends PerformanceDisplayRecord {
  groupLabel: string;
}

interface DimensionValues {
  models: string[];
  upstreams: string[];
  operations: string[];
  runtimeLocations: string[];
  keyIds: string[];
  userIds: number[];
}

interface UserMetadata { id: number; username: string }
interface KeyMetadata { id: string; name: string; createdAt: string }

interface PerformanceOverviewResponse {
  series: PerformanceDisplayRecord[];
  summaryRows: PerformanceDisplayRecord[];
  modelRows: PerformanceDisplayRecord[];
  upstreamRows: PerformanceDisplayRecord[];
  runtimeRows: PerformanceDisplayRecord[];
  operationRows: PerformanceDisplayRecord[];
  keyRows: PerformanceDisplayRecord[];
  userRows: PerformanceDisplayRecord[];
  dimensionValues: DimensionValues;
  users: UserMetadata[];
  keys: KeyMetadata[];
}

const emptyOverview = (): PerformanceOverviewResponse => ({
  series: [], summaryRows: [], modelRows: [], upstreamRows: [], runtimeRows: [], operationRows: [], keyRows: [], userRows: [],
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [], keys: [],
});

// URL <-> state (de)serialization. Every widget's state lives in the URL query
// so refreshing / copying the URL restores the same view. Only non-default
// values are written so pristine URLs stay clean.
const GROUP_BY_VALUES = ['model', 'upstream', 'operation', 'runtimeLocation', 'keyId', 'userId'] as const;
const METRIC_VALUES = ['ttft', 'tokPerSec'] as const;
const PERCENTILE_VALUES = ['p50', 'p95', 'p99'] as const;
const RANGE_VALUES = ['today', '7d', '30d'] as const;
const SORT_KEY_VALUES = ['group', 'requests', 'errors', 'ttftMsP95', 'tpotUsP95'] as const;
const SORT_DIR_VALUES = ['asc', 'desc'] as const;

const asStr = (v: LocationQueryValue | LocationQueryValue[] | undefined): string =>
  (typeof v === 'string' ? v : '');
const asOneOf = <T extends string>(v: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

interface UrlState {
  metric: MetricView;
  percentile: PercentileKey;
  groupBy: GroupBy;
  range: DashboardRange;
  filterModel: string;
  filterUpstream: string;
  filterOperation: string;
  filterRuntime: string;
  filterUserId: string;
  filterKeyId: string;
  hidden: string[];
  sortKey: TableSortKey;
  sortDir: SortDir;
}

// Single source of truth for URL <-> UrlState. Every field declares its
// query key, how to parse a raw string, and how to serialize back — returning
// `undefined` from `serialize` elides the key so pristine defaults leave no
// query string behind. parseUrlState and serializeUrlState both loop over
// this map, so read and write can never drift.
interface UrlField<T> {
  urlKey: string;
  parse: (v: string) => T;
  serialize: (v: T) => string | undefined;
}

const enumField = <T extends string>(urlKey: string, allowed: readonly T[], fallback: T): UrlField<T> => ({
  urlKey,
  parse: v => asOneOf(v, allowed, fallback),
  serialize: v => (v === fallback ? undefined : v),
});

const stringField = (urlKey: string): UrlField<string> => ({
  urlKey,
  parse: v => v,
  serialize: v => (v === '' ? undefined : v),
});

const URL_FIELDS = {
  metric: enumField('m', METRIC_VALUES, 'ttft'),
  percentile: enumField('pct', PERCENTILE_VALUES, 'p95'),
  groupBy: enumField('g', GROUP_BY_VALUES, 'model'),
  range: enumField('r', RANGE_VALUES, 'today'),
  filterModel: stringField('fm'),
  filterUpstream: stringField('fu'),
  filterOperation: stringField('fo'),
  filterRuntime: stringField('fr'),
  filterUserId: stringField('fusr'),
  filterKeyId: stringField('fk'),
  hidden: {
    urlKey: 'hide',
    parse: (v: string): string[] => v.split(',').map(decodeURIComponent).filter(Boolean),
    serialize: (v: string[]) => (v.length > 0 ? v.map(encodeURIComponent).join(',') : undefined),
  },
  sortKey: enumField('sort', SORT_KEY_VALUES, 'requests'),
  sortDir: enumField('dir', SORT_DIR_VALUES, 'desc'),
} satisfies { [K in keyof UrlState]: UrlField<UrlState[K]> };

const parseUrlState = (q: LocationQuery): UrlState => {
  const out: Partial<Record<keyof UrlState, unknown>> = {};
  for (const key of Object.keys(URL_FIELDS) as (keyof UrlState)[]) {
    const field = URL_FIELDS[key];
    out[key] = field.parse(asStr(q[field.urlKey]));
  }
  return out as UrlState;
};

const serializeUrlState = (state: UrlState): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(URL_FIELDS) as (keyof UrlState)[]) {
    const field = URL_FIELDS[key];
    // Union-of-serialize collapses its param type to `never` under
    // contravariance; cast state[key] so the loop compiles. Runtime call is
    // sound because the `satisfies` clause pairs each key with its own field.
    const value = field.serialize(state[key] as never);
    if (value !== undefined) out[field.urlKey] = value;
  }
  return out;
};

const buildOverviewQuery = (state: UrlState, view: PerformanceView, at: number): Record<string, string> => {
  const { start, end, bucket } = dashboardRangeQuery(state.range, at);
  const q: Record<string, string> = {
    start, end, bucket,
    timezone_offset_minutes: String(new Date().getTimezoneOffset()),
    view,
    group_by: state.groupBy,
  };
  if (state.filterModel !== '') q.filter_model = state.filterModel;
  if (state.filterUpstream !== '') q.filter_upstream = state.filterUpstream;
  if (state.filterOperation !== '') q.filter_operation = state.filterOperation;
  if (state.filterRuntime !== '') q.filter_runtime_location = state.filterRuntime;
  if (state.filterUserId !== '') q.filter_user_id = state.filterUserId;
  if (state.filterKeyId !== '') q.filter_key_id = state.filterKeyId;
  return q;
};

export const usePerformancePageData = defineBasicLoader('/dashboard/performance', async route => {
  const api = useApi();
  const auth = useAuthStore();
  const upstreamsStore = useUpstreamsStore();
  const view: PerformanceView = auth.canViewGlobalTelemetry ? 'all-by-user' : 'self-by-key';
  const initial = parseUrlState(route.query);
  const query = buildOverviewQuery(initial, view, Date.now());
  // Load upstream names in parallel with the perf overview so By-Upstream tables
  // and chart legends can resolve upstream ids to human-readable names. Store is
  // module-scoped, so this is a no-op when the user has already visited Settings.
  const [overviewRes] = await Promise.all([
    callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({ query })),
    upstreamsStore.upstreams.value
      ? Promise.resolve()
      : upstreamsStore.load().catch(err => {
          // Surface but don't fail the dashboard load — the By-Upstream table
          // falls back to raw ids. Operator sees the console warning if the
          // name-resolution API failed vs. an upstream genuinely being hard-deleted.
          console.warn('Failed to load upstreams for name resolution:', err);
        }),
  ]);
  return {
    view,
    overview: overviewRes.data ?? emptyOverview(),
    error: overviewRes.error ? overviewRes.error.message : null,
  };
});
</script>

<script setup lang="ts">
const api = useApi();
const upstreamsStore = useUpstreamsStore();
const route = useRoute();
const router = useRouter();
const initialOverview = usePerformancePageData();

// View is resolved once from the caller's permission — admins see all users'
// data, regular users see only their own keys. The dashboard doesn't expose
// a toggle; the underlying backend `view` param is still threaded through.
const performanceView: PerformanceView = initialOverview.data.value.view;

// Initialize every ref from the URL so the page opens in the same state that
// was captured when the URL was minted (bookmark / share). The subsequent
// syncStateToUrl watchEffect writes changes back so refreshing preserves them.
const initial = parseUrlState(route.query);
const filterModel = ref<string>(initial.filterModel);
const filterUpstream = ref<string>(initial.filterUpstream);
const filterOperation = ref<string>(initial.filterOperation);
const filterRuntime = ref<string>(initial.filterRuntime);
const filterUserId = ref<string>(initial.filterUserId);
const filterKeyId = ref<string>(initial.filterKeyId);
const performanceRange = ref<DashboardRange>(initial.range);
const loadedPerformanceRange = ref<DashboardRange>(initial.range);
// Buckets and the request window are derived from the same `loadedAt` so the
// chart axis stays in lockstep with whichever data snapshot is currently shown.
const loadedAt = ref(Date.now());
const performanceMetric = ref<MetricView>(initial.metric);
const performancePercentile = ref<PercentileKey>(initial.percentile);
const performanceGroupBy = ref<GroupBy>(initial.groupBy);
const hiddenPerformanceSeries = ref(new Set<string>(initial.hidden));
const tableSortKey = ref<TableSortKey>(initial.sortKey);
const tableSortDir = ref<SortDir>(initial.sortDir);

// shallowRef: the overview response is only ever replaced whole
// (load() assigns `overview.value = data` on refetch); nested arrays
// and rows never mutate in place, so recursive reactive proxying of
// every row's fields would burn cycles for zero gain.
const overview = shallowRef<PerformanceOverviewResponse>(initialOverview.data.value.overview);
const performanceError = ref<string | null>(initialOverview.data.value.error);
const performanceLoading = ref(false);
let performanceRequestId = 0;

const currentUrlState = (): UrlState => ({
  metric: performanceMetric.value,
  percentile: performancePercentile.value,
  groupBy: performanceGroupBy.value,
  range: performanceRange.value,
  filterModel: filterModel.value,
  filterUpstream: filterUpstream.value,
  filterOperation: filterOperation.value,
  filterRuntime: filterRuntime.value,
  filterUserId: filterUserId.value,
  filterKeyId: filterKeyId.value,
  hidden: [...hiddenPerformanceSeries.value],
  sortKey: tableSortKey.value,
  sortDir: tableSortDir.value,
});

const load = async () => {
  const requestId = ++performanceRequestId;
  const requestedRange = performanceRange.value;
  const requestedAt = Date.now();
  performanceLoading.value = true;
  const query = buildOverviewQuery(currentUrlState(), performanceView, requestedAt);
  const { data, error: err } = await callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({ query }));
  if (requestId !== performanceRequestId) return;
  performanceLoading.value = false;
  if (err) { performanceError.value = err.message; return; }
  performanceError.value = null;
  overview.value = data;
  loadedPerformanceRange.value = requestedRange;
  loadedAt.value = requestedAt;
};

// Any of these state fields going in => triggers a re-fetch (they all affect
// the response). Chart-only fields (hiddenPerformanceSeries) and pure display
// fields (percentile, metric, sort key/dir) don't need a re-fetch.
watch([performanceRange, performanceGroupBy, filterModel, filterUpstream, filterOperation, filterRuntime, filterUserId, filterKeyId], load);

// Switching groupBy re-shapes the chart around a new axis; the hidden-series
// set was captured against the previous axis and its ids are meaningless in
// the new one. Reset so the new view starts fully visible — the sync-to-URL
// watchEffect drops the `hide=` param automatically once the set is empty.
watch(performanceGroupBy, () => {
  hiddenPerformanceSeries.value.clear();
});

// Background tabs shouldn't burn backend cycles running the 6-way overview
// aggregation every 60s while nobody's looking. Gate the poll on document
// visibility and resume the loop as soon as the user comes back. `resume()`
// only re-arms the interval; without an immediate fetch a tab that came
// back after 10 minutes would keep showing stale data for up to 60s. Force
// a load on every visible-again transition — but skip the first invocation
// (immediate: true fires it during setup, when the route loader has just
// populated overview.value and a second identical request would waste a
// round trip).
const { pause: pausePoll, resume: resumePoll } = useIntervalFn(() => { void load(); }, 60_000);
const documentVisibility = useDocumentVisibility();
let visibilityInitialized = false;
watch(documentVisibility, v => {
  if (v === 'visible') {
    resumePoll();
    if (visibilityInitialized) void load();
  } else {
    pausePoll();
  }
  visibilityInitialized = true;
}, { immediate: true });

// Sync every state field to the URL query via URL_FIELDS so a pristine
// dashboard URL stays `/dashboard/performance` with no junk trailing it.
// `router.replace` (not `push`) so click-heavy toggling doesn't flood the
// browser history. vue-router 4's internal navigate() catches
// NAVIGATION_CANCELLED and pushWithRedirect swallows every other
// NavigationFailure via markAsReady, so this promise never rejects for
// benign duplicated/aborted races — a real thrown error from a guard is
// a real bug and should surface as an unhandled rejection.
watchEffect(() => {
  void router.replace({ query: serializeUrlState(currentUrlState()) });
});

// Group-by dropdown: By User is admin-only (every self-view row belongs
// to the actor by construction, so splitting by user is a no-op there).
// By API Key is available in both views — admins see every user's keys,
// self-scoped users see only their own.
const groupByOptions: { value: GroupBy; label: string }[] = [
  { value: 'model', label: 'By Model' },
  { value: 'upstream', label: 'By Upstream' },
  { value: 'operation', label: 'By Operation' },
  { value: 'runtimeLocation', label: 'By Region' },
  { value: 'keyId', label: 'By API Key' },
  ...(performanceView === 'all-by-user' ? [{ value: 'userId' as const, label: 'By User' }] : []),
];

const performanceSeriesIsolation = createSeriesIsolation();

// Name resolvers — all three (upstream, user, API key) look up display names
// from separate metadata sources. resolveGroupName picks the right one based
// on the row's group dimension so tables render "Copilot GHE" / "admin" /
// "my-cli-key" rather than raw ids.
const upstreamNameById = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const u of upstreamsStore.upstreams.value ?? []) map.set(u.id, u.name);
  return map;
});
const userNameById = computed<Map<number, string>>(() => {
  const map = new Map<number, string>();
  for (const u of overview.value.users) map.set(u.id, u.username);
  return map;
});
const keyNameById = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const k of overview.value.keys) map.set(k.id, k.name);
  return map;
});
const resolveGroupName = (group: string, groupBy: GroupBy): string => {
  if (groupBy === 'upstream') return upstreamNameById.value.get(group) ?? group;
  if (groupBy === 'userId') return userNameById.value.get(Number(group)) ?? `user ${group}`;
  if (groupBy === 'keyId') return keyNameById.value.get(group) ?? group;
  return group;
};

const tableSortToggle = (key: TableSortKey): void => {
  if (tableSortKey.value === key) {
    tableSortDir.value = tableSortDir.value === 'asc' ? 'desc' : 'asc';
    return;
  }
  tableSortKey.value = key;
  // Default: string columns start ascending (A-Z), numeric columns start
  // descending (biggest first — the failure mode operators scan for).
  tableSortDir.value = key === 'group' ? 'asc' : 'desc';
};

// Output speed is stored as tpotUs (smaller = faster), but the column
// header labels it "Output speed" (tok/s, higher = better), so clicking
// asc/desc must produce the ordering the label promises. Bake the invert
// into a single effectiveSign so null-handling stays consistent — nulls
// always sort last regardless of direction. Every row also carries its
// resolved group label — resolveGroupName reads a Map per invocation, so
// pre-resolving once per row keeps the group-column sort cheap AND lets
// the template render `{{ row.groupLabel }}` without walking the Map on
// every reactive tick across the 6 breakdown tables.
const sortedRows = (rows: readonly PerformanceDisplayRecord[], groupBy: GroupBy): DisplayRow[] => {
  const key = tableSortKey.value;
  const dir = tableSortDir.value;
  const invert = key === 'tpotUsP95' ? -1 : 1;
  const sign = (dir === 'asc' ? 1 : -1) * invert;
  const withLabel: DisplayRow[] = rows.map(r => ({ ...r, groupLabel: resolveGroupName(r.group, groupBy) }));
  if (key === 'group') {
    return withLabel.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) * sign);
  }
  const compareNumbers = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * sign;
  };
  return withLabel.sort((a, b) => compareNumbers(a[key], b[key]));
};

// Every reactive tick — including loading-spinner opacity toggles — would
// re-invoke sortedRows for all 6 tables if it stayed a template-called
// function. Wrap the 6 rows arrays in a single computed so the sort only
// re-runs when its actual inputs change (row snapshot, sort key/dir, or
// any name-resolver map behind the group-column sort).
const breakdownTables = computed(() => [
  { key: 'model' as const, label: 'By Model', rows: overview.value.modelRows, header: 'Model' },
  { key: 'upstream' as const, label: 'By Upstream', rows: overview.value.upstreamRows, header: 'Upstream' },
  { key: 'runtimeLocation' as const, label: 'By Region', rows: overview.value.runtimeRows, header: 'Region' },
  { key: 'operation' as const, label: 'By Operation', rows: overview.value.operationRows, header: 'Operation' },
  { key: 'userId' as const, label: 'By User', rows: overview.value.userRows, header: 'User' },
  { key: 'keyId' as const, label: 'By API Key', rows: overview.value.keyRows, header: 'API Key' },
].map(t => ({ ...t, sortedRows: sortedRows(t.rows, t.key) })));

const sortIndicator = (key: TableSortKey): string => {
  if (tableSortKey.value !== key) return '';
  return tableSortDir.value === 'asc' ? ' ↑' : ' ↓';
};

const formatMs = (ms: number | null) => {
  if (ms === null) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const formatTps = (tps: number | null): string => {
  if (tps === null || tps <= 0) return '—';
  if (tps >= 100) return `${Math.round(tps)} tok/s`;
  if (tps >= 10) return `${tps.toFixed(1)} tok/s`;
  return `${tps.toFixed(2)} tok/s`;
};

const formatTokPerSec = (us: number | null): string =>
  us === null || us <= 0 ? '—' : formatTps(1_000_000 / us);

const getChartValue = (record: PerformanceDisplayRecord, p: PercentileKey): number | null => {
  if (performanceMetric.value === 'ttft') {
    if (p === 'p50') return record.ttftMsP50;
    if (p === 'p95') return record.ttftMsP95;
    return record.ttftMsP99;
  }
  const us = p === 'p50' ? record.tpotUsP50 : p === 'p95' ? record.tpotUsP95 : record.tpotUsP99;
  return us === null || us <= 0 ? null : 1_000_000 / us;
};

const chartConfig = computed<ChartConfiguration<'line'>>(() => {
  const { keys: bucketKeys, labels } = dashboardBuckets(loadedPerformanceRange.value, loadedAt.value);
  const metric = performanceMetric.value;
  const formatter = metric === 'ttft' ? formatMs : formatTps;
  const yTitle = metric === 'ttft' ? 'TTFT (ms)' : 'Output speed (tok/s)';

  const groups = new Map<string, Map<string, number | null>>();
  for (const r of overview.value.series) {
    let inner = groups.get(r.group);
    if (!inner) {
      inner = new Map<string, number | null>();
      groups.set(r.group, inner);
    }
    inner.set(r.bucket, getChartValue(r, performancePercentile.value));
  }
  // By-User / By-API-Key axes have server-sorted metadata (stable id order),
  // so map each group name into that metadata slot for a color that matches
  // the usage dashboard's palette assignment. Orphan ids (deleted-with-no-row)
  // or non-user/key axes fall back to the name-hashed palette entry — still
  // stable, just not slot-aligned.
  const colorFor = (groupName: string): string => {
    if (performanceGroupBy.value === 'userId') {
      const slot = overview.value.users.findIndex(u => String(u.id) === groupName);
      return slot >= 0 ? chartColor(slot) : chartColorByName(groupName);
    }
    if (performanceGroupBy.value === 'keyId') {
      const slot = overview.value.keys.findIndex(k => k.id === groupName);
      return slot >= 0 ? chartColor(slot) : chartColorByName(groupName);
    }
    return chartColorByName(groupName);
  };
  const datasets = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, byBucket]) => {
    const color = colorFor(group);
    return {
      label: resolveGroupName(group, performanceGroupBy.value),
      seriesId: group,
      hidden: hiddenPerformanceSeries.value.has(group),
      data: bucketKeys.map(k => byBucket.get(k) ?? null),
      borderColor: color,
      backgroundColor: `${color}25`,
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 5,
      tension: 0.25,
      fill: false,
      spanGaps: true,
    };
  });

  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      events: chartEventsWithDoubleClick,
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#9e9e9e', font: { size: 11, family: chartFont.sans }, boxWidth: 12, padding: 16, usePointStyle: true, pointStyle: 'circle' },
          onClick: (event, legendItem) => {
            const dataset = datasets[legendItem.datasetIndex!];
            handleLegendClick(event, performanceSeriesIsolation, hiddenPerformanceSeries.value, datasets.map(d => d.seriesId), dataset.seriesId);
          },
        },
        tooltip: {
          backgroundColor: 'rgba(12,16,21,0.95)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#e0e0e0',
          bodyColor: '#b0bec5',
          padding: 12,
          bodyFont: { family: chartFont.mono, size: 11 },
          filter: item => item.parsed.y !== null,
          callbacks: { label: (ctx: TooltipItem<'line'>) => `${ctx.dataset.label}: ${formatter(Number(ctx.parsed.y))}` },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#9e9e9e',
            maxRotation: 45,
            font: { size: 10, family: chartFont.sans },
            padding: 6,
            callback: chartXAxisTick(bucketKeys, labels, loadedPerformanceRange.value === '7d'),
          },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
        y: {
          type: 'logarithmic',
          beginAtZero: false,
          title: { display: true, text: yTitle, color: '#9e9e9e', font: { size: 10, family: chartFont.sans } },
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#9e9e9e', font: { size: 10, family: chartFont.mono }, callback: v => formatter(Number(v)) },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  };
});

const performanceSeriesIds = computed(() => chartSeriesIds(chartConfig.value));

const performanceSummary = computed<PerformanceDisplayRecord>(() => overview.value.summaryRows[0] ?? {
  bucket: 'all',
  group: 'all',
  requests: 0,
  errors: 0,
  ttftSamples: 0,
  tpotSamples: 0,
  neutral: 0,
  ttftMsP50: null,
  ttftMsP95: null,
  ttftMsP99: null,
  tpotUsP50: null,
  tpotUsP95: null,
  tpotUsP99: null,
});
</script>

<template>
  <div>
    <div class="glass-card p-6 animate-in">
      <!-- Row 1: metric (left) · group-by (next-left) · percentile (next-right) · time range (right) -->
      <div class="flex flex-col gap-3 mb-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mr-1">Performance</span>
          <OverlayScrollbars class="max-w-full rounded-lg bg-surface-800" content-class="flex items-center gap-1 p-0.5" no-tabindex>
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceMetric === 'ttft' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceMetric = 'ttft'"
            >TTFT</button>
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceMetric === 'tokPerSec' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceMetric = 'tokPerSec'"
            >Output speed</button>
          </OverlayScrollbars>
          <select
            v-model="performanceGroupBy"
            class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none"
            aria-label="Group by"
          >
            <option v-for="opt in groupByOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <!-- Loading spinner sits next to the group-by dropdown but always
               occupies its slot (opacity toggle instead of v-if) so the row
               above the chart doesn't reflow every refresh. -->
          <Spinner class="h-3.5 w-3.5 text-gray-500 transition-opacity" :class="performanceLoading ? 'opacity-100' : 'opacity-0'" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <OverlayScrollbars class="max-w-full rounded-lg bg-surface-800" content-class="flex items-center gap-1 p-0.5" no-tabindex>
            <button
              v-for="p in (['p50', 'p95', 'p99'] as const)"
              :key="p"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performancePercentile === p ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performancePercentile = p"
            >{{ p }}</button>
          </OverlayScrollbars>
          <OverlayScrollbars class="max-w-full rounded-lg bg-surface-800" content-class="flex items-center gap-1 p-0.5" no-tabindex>
            <button
              v-for="r in (['today', '7d', '30d'] as const)"
              :key="r"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceRange === r ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceRange = r"
            >{{ r === 'today' ? 'Last Day' : r === '7d' ? '7 Days' : '30 Days' }}</button>
          </OverlayScrollbars>
        </div>
      </div>

      <!-- Row 2: filter dropdowns — every filter is AND at the backend, options are drawn from the un-filtered dataset.
           The dimension currently used as the group-by axis is hidden (filtering to one value would collapse the split).
           User and API Key are hierarchically related (a key belongs to exactly one user), so grouping by either hides
           both filters — cross-hierarchy filtering just degenerates the view. -->
      <div class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label v-if="performanceGroupBy !== 'model'" class="flex items-center gap-1.5 text-xs text-gray-500">
          <span>Model:</span>
          <select v-model="filterModel" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none">
            <option value="">All</option>
            <option v-for="v in overview.dimensionValues.models" :key="v" :value="v">{{ v }}</option>
          </select>
        </label>
        <label v-if="performanceGroupBy !== 'upstream'" class="flex items-center gap-1.5 text-xs text-gray-500">
          <span>Upstream:</span>
          <select v-model="filterUpstream" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none">
            <option value="">All</option>
            <option v-for="v in overview.dimensionValues.upstreams" :key="v" :value="v">{{ upstreamNameById.get(v) ?? v }}</option>
          </select>
        </label>
        <label v-if="performanceGroupBy !== 'operation'" class="flex items-center gap-1.5 text-xs text-gray-500">
          <span>Operation:</span>
          <select v-model="filterOperation" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none">
            <option value="">All</option>
            <option v-for="v in overview.dimensionValues.operations" :key="v" :value="v">{{ v }}</option>
          </select>
        </label>
        <label v-if="performanceGroupBy !== 'runtimeLocation'" class="flex items-center gap-1.5 text-xs text-gray-500">
          <span>Region:</span>
          <select v-model="filterRuntime" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none">
            <option value="">All</option>
            <option v-for="v in overview.dimensionValues.runtimeLocations" :key="v" :value="v">{{ v }}</option>
          </select>
        </label>
        <label v-if="performanceView === 'all-by-user' && performanceGroupBy !== 'userId' && performanceGroupBy !== 'keyId'" class="flex items-center gap-1.5 text-xs text-gray-500">
          <span>User:</span>
          <select v-model="filterUserId" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none">
            <option value="">All</option>
            <option v-for="v in overview.dimensionValues.userIds" :key="v" :value="String(v)">{{ userNameById.get(v) ?? `user ${v}` }}</option>
          </select>
        </label>
        <label v-if="performanceGroupBy !== 'keyId' && performanceGroupBy !== 'userId'" class="flex items-center gap-1.5 text-xs text-gray-500">
          <span>API Key:</span>
          <select v-model="filterKeyId" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none">
            <option value="">All</option>
            <option v-for="v in overview.dimensionValues.keyIds" :key="v" :value="v">{{ keyNameById.get(v) ?? v }}</option>
          </select>
        </label>
      </div>

      <div v-if="performanceError" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ performanceError }}
      </div>

      <div class="mb-2 flex justify-end">
        <ChartSeriesControls label="Performance series selection" @select="applySeriesSelection(hiddenPerformanceSeries, performanceSeriesIds, $event)" />
      </div>
      <div style="height: 340px; position: relative;">
        <ChartCanvas :config="chartConfig" />
      </div>

      <!-- Stat cards. Three different orderings by breakpoint:
             sm (2 cols):  Req | Err            → DOM source order
                           TTFT p50 | OS p50
                           TTFT p95 | OS p95
                           TTFT p99 | OS p99
             lg (4 cols):  Req | TTFT p50 | TTFT p95 | TTFT p99
                           Err | OS p50   | OS p95   | OS p99
             xl (8 cols):  Req | Err | TTFT p50 | TTFT p95 | TTFT p99 | OS p50 | OS p95 | OS p99
           The DOM matches the narrow ordering (TTFT and Output speed
           interleaved by percentile) and each card carries `lg:` / `xl:`
           `order-*` overrides for the wider layouts. -->
      <div class="grid grid-cols-2 gap-3 mt-6 lg:grid-cols-4 xl:grid-cols-8">
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-1 xl:order-1">
          <span class="block text-xs text-gray-500 mb-1">Requests</span>
          <span class="block text-lg font-bold font-mono text-white">{{ performanceSummary.requests.toLocaleString() }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-5 xl:order-2">
          <span class="block text-xs text-gray-500 mb-1">Errors</span>
          <span class="block text-lg font-bold font-mono text-white">{{ performanceSummary.errors.toLocaleString() }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-2 xl:order-3">
          <span class="block text-xs text-gray-500 mb-1">TTFT p50</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP50) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-6 xl:order-6">
          <span class="block text-xs text-gray-500 mb-1">Output speed p50</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTokPerSec(performanceSummary.tpotUsP50) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-3 xl:order-4">
          <span class="block text-xs text-gray-500 mb-1">TTFT p95</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP95) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-7 xl:order-7">
          <span class="block text-xs text-gray-500 mb-1">Output speed p95</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTokPerSec(performanceSummary.tpotUsP95) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-4 xl:order-5">
          <span class="block text-xs text-gray-500 mb-1">TTFT p99</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP99) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-8 xl:order-8">
          <span class="block text-xs text-gray-500 mb-1">Output speed p99</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTokPerSec(performanceSummary.tpotUsP99) }}</span>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-5 mt-6 pt-5 border-t border-white/5 lg:grid-cols-2">
        <div v-for="table in breakdownTables" :key="table.key" v-show="table.rows.length > 0">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3 block">{{ table.label }}</span>
          <OverlayScrollbars class="rounded-md border border-white/5" no-tabindex>
            <table class="w-full text-sm">
              <thead class="bg-surface-800/70 text-xs uppercase tracking-widest text-gray-500">
                <tr>
                  <th class="px-3 py-2 text-left font-medium cursor-pointer select-none hover:text-gray-300" @click="tableSortToggle('group')">{{ table.header }}{{ sortIndicator('group') }}</th>
                  <th class="px-3 py-2 text-right font-medium cursor-pointer select-none hover:text-gray-300" @click="tableSortToggle('requests')">Req{{ sortIndicator('requests') }}</th>
                  <th class="px-3 py-2 text-right font-medium cursor-pointer select-none hover:text-gray-300" @click="tableSortToggle('errors')">Errors{{ sortIndicator('errors') }}</th>
                  <th class="px-3 py-2 text-right font-medium cursor-pointer select-none hover:text-gray-300" @click="tableSortToggle('ttftMsP95')">TTFT p95{{ sortIndicator('ttftMsP95') }}</th>
                  <th class="px-3 py-2 text-right font-medium cursor-pointer select-none hover:text-gray-300" @click="tableSortToggle('tpotUsP95')">Output speed p95{{ sortIndicator('tpotUsP95') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-for="row in table.sortedRows" :key="row.group">
                  <td class="px-3 py-2 text-gray-300">{{ row.groupLabel }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ row.requests.toLocaleString() }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ row.errors.toLocaleString() }}</td>
                  <td class="px-3 py-2 text-right font-mono text-white">{{ formatMs(row.ttftMsP95) }}</td>
                  <td class="px-3 py-2 text-right font-mono text-white">{{ formatTokPerSec(row.tpotUsP95) }}</td>
                </tr>
              </tbody>
            </table>
          </OverlayScrollbars>
        </div>
      </div>
    </div>
  </div>
</template>
