<script lang="ts">
import { useIntervalFn } from '@vueuse/core';
import type { TooltipItem } from 'chart.js';
import type { ChartConfiguration } from 'chart.js/auto';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import ChartCanvas from '../../components/charts/ChartCanvas.vue';
import ChartSeriesControls from '../../components/charts/ChartSeriesControls.vue';
import { chartColor, chartFont, chartXAxisTick, dashboardBuckets, dashboardRangeQuery, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import { applySeriesSelection, chartEventsWithDoubleClick, chartSeriesIds, createSeriesIsolation, handleLegendClick } from '../../components/charts/series-selection.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

type PerformanceView = 'all-by-user' | 'self-by-key';
type GroupBy = 'keyId' | 'userId' | 'model' | 'upstream' | 'operation' | 'runtimeLocation';

interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  ttftMsP50: number | null;
  ttftMsP95: number | null;
  ttftMsP99: number | null;
  tpotUsP50: number | null;
  tpotUsP95: number | null;
  tpotUsP99: number | null;
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

export const usePerformancePageData = defineBasicLoader(async () => {
  const api = useApi();
  const auth = useAuthStore();
  const upstreamsStore = useUpstreamsStore();
  const view: PerformanceView = auth.canViewGlobalTelemetry ? 'all-by-user' : 'self-by-key';
  const { start, end, bucket } = dashboardRangeQuery('today', Date.now());
  // Load upstream names in parallel with the perf overview so By-Upstream tables
  // and chart legends can resolve upstream ids to human-readable names. Store is
  // module-scoped, so this is a no-op when the user has already visited Settings.
  const [overviewRes] = await Promise.all([
    callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({
      query: { start, end, bucket, timezone_offset_minutes: String(new Date().getTimezoneOffset()), view },
    })),
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
type MetricView = 'ttft' | 'tokPerSec';
type PercentileKey = 'p50' | 'p95' | 'p99';

const api = useApi();
const auth = useAuthStore();
const upstreamsStore = useUpstreamsStore();
const initialOverview = usePerformancePageData();

// View is resolved once from the caller's permission — admins see all users'
// data, regular users see only their own keys. The dashboard doesn't expose
// a toggle; the underlying backend `view` param is still threaded through.
const performanceView: PerformanceView = initialOverview.data.value.view;

// Filters applied at the backend before aggregation. Empty string = no filter.
const filterModel = ref<string>('');
const filterUpstream = ref<string>('');
const filterOperation = ref<string>('');
const filterRuntime = ref<string>('');
const filterUserId = ref<string>('');   // numeric string; backend parses
const filterKeyId = ref<string>('');

const performanceRange = ref<DashboardRange>('today');
const loadedPerformanceRange = ref<DashboardRange>('today');
// Buckets and the request window are derived from the same `loadedAt` so the
// chart axis stays in lockstep with whichever data snapshot is currently shown.
const loadedAt = ref(Date.now());
const performanceMetric = ref<MetricView>('ttft');
const performancePercentile = ref<PercentileKey>('p95');
const performanceGroupBy = ref<GroupBy>('model');
const hiddenPerformanceSeries = ref(new Set<string>());

const overview = ref<PerformanceOverviewResponse>(initialOverview.data.value.overview);
const performanceError = ref<string | null>(initialOverview.data.value.error);
const performanceLoading = ref(false);
let performanceRequestId = 0;

const load = async () => {
  const requestId = ++performanceRequestId;
  const requestedRange = performanceRange.value;
  const requestedGroupBy = performanceGroupBy.value;
  const requestedAt = Date.now();
  performanceLoading.value = true;
  const { start, end, bucket } = dashboardRangeQuery(requestedRange, requestedAt);
  const query: Record<string, string> = {
    start, end, bucket,
    timezone_offset_minutes: String(new Date().getTimezoneOffset()),
    view: performanceView,
    group_by: requestedGroupBy,
  };
  if (filterModel.value !== '') query.filter_model = filterModel.value;
  if (filterUpstream.value !== '') query.filter_upstream = filterUpstream.value;
  if (filterOperation.value !== '') query.filter_operation = filterOperation.value;
  if (filterRuntime.value !== '') query.filter_runtime_location = filterRuntime.value;
  if (filterUserId.value !== '') query.filter_user_id = filterUserId.value;
  if (filterKeyId.value !== '') query.filter_key_id = filterKeyId.value;

  const { data, error: err } = await callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({ query }));
  if (requestId !== performanceRequestId) return;
  performanceLoading.value = false;
  if (err) { performanceError.value = err.message; return; }
  performanceError.value = null;
  overview.value = data;
  loadedPerformanceRange.value = requestedRange;
  loadedAt.value = requestedAt;
};

watch([performanceRange, performanceGroupBy, filterModel, filterUpstream, filterOperation, filterRuntime, filterUserId, filterKeyId], load);
useIntervalFn(() => { void load(); }, 60_000);

// Group-by dropdown options depend on view: keyId only makes sense in
// self-by-key (the actor's own keys), userId only in all-by-user (admins).
const groupByOptions = computed<{ value: GroupBy; label: string }[]>(() => {
  const shared: { value: GroupBy; label: string }[] = [
    { value: 'model', label: 'By Model' },
    { value: 'upstream', label: 'By Upstream' },
    { value: 'operation', label: 'By Operation' },
    { value: 'runtimeLocation', label: 'By Region' },
  ];
  if (performanceView === 'all-by-user') return [...shared, { value: 'userId', label: 'By User' }];
  return [...shared, { value: 'keyId', label: 'By API Key' }];
});

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

// Shared sort key across all break-down tables. Every table carries the same
// columns (Req / Errors / TTFT p95 / Output speed p95) so clicking any header
// re-orders every table. Independent from the chart's metric/percentile.
type TableSortKey = 'group' | 'requests' | 'errors' | 'ttftMsP95' | 'tpotUsP95';
type SortDir = 'asc' | 'desc';
const tableSortKey = ref<TableSortKey>('requests');
const tableSortDir = ref<SortDir>('desc');

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

// tok/s (Output speed) is inverted from tpotUs: bigger tok/s = smaller tpotUs.
// Clicking "Output speed p95 ↓" expects "fastest first", so we invert the
// direction for that column so the visible ordering matches the label.
const sortedRows = (rows: readonly PerformanceDisplayRecord[], groupBy: GroupBy): PerformanceDisplayRecord[] => {
  const key = tableSortKey.value;
  const dir = tableSortDir.value;
  const sign = dir === 'asc' ? 1 : -1;
  const compareNumbers = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * sign;
  };
  return [...rows].sort((a, b) => {
    if (key === 'group') {
      return resolveGroupName(a.group, groupBy).localeCompare(resolveGroupName(b.group, groupBy)) * sign;
    }
    if (key === 'tpotUsP95') {
      return compareNumbers(a.tpotUsP95, b.tpotUsP95) * -1;
    }
    return compareNumbers(a[key], b[key]);
  });
};

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
    const inner = groups.get(r.group) ?? new Map<string, number | null>();
    inner.set(r.bucket, getChartValue(r, performancePercentile.value));
    groups.set(r.group, inner);
  }
  const datasets = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, byBucket], i) => {
    const color = chartColor(i);
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
          <Spinner v-if="performanceLoading" class="h-3.5 w-3.5 text-gray-500 mr-1" />
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

      <!-- Row 2: filter dropdowns — every filter is AND at the backend, options are drawn from the un-filtered dataset -->
      <div class="mb-6 flex flex-wrap items-center gap-2">
        <select v-model="filterModel" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none" aria-label="Filter model">
          <option value="">All models</option>
          <option v-for="v in overview.dimensionValues.models" :key="v" :value="v">{{ v }}</option>
        </select>
        <select v-model="filterUpstream" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none" aria-label="Filter upstream">
          <option value="">All upstreams</option>
          <option v-for="v in overview.dimensionValues.upstreams" :key="v" :value="v">{{ upstreamNameById.get(v) ?? v }}</option>
        </select>
        <select v-model="filterOperation" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none" aria-label="Filter operation">
          <option value="">All operations</option>
          <option v-for="v in overview.dimensionValues.operations" :key="v" :value="v">{{ v }}</option>
        </select>
        <select v-model="filterRuntime" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none" aria-label="Filter region">
          <option value="">All regions</option>
          <option v-for="v in overview.dimensionValues.runtimeLocations" :key="v" :value="v">{{ v }}</option>
        </select>
        <select v-if="performanceView === 'all-by-user'" v-model="filterUserId" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none" aria-label="Filter user">
          <option value="">All users</option>
          <option v-for="v in overview.dimensionValues.userIds" :key="v" :value="String(v)">{{ userNameById.get(v) ?? `user ${v}` }}</option>
        </select>
        <select v-if="performanceView === 'self-by-key'" v-model="filterKeyId" class="shrink-0 rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-gray-300 outline-none" aria-label="Filter API key">
          <option value="">All API keys</option>
          <option v-for="v in overview.dimensionValues.keyIds" :key="v" :value="v">{{ keyNameById.get(v) ?? v }}</option>
        </select>
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

      <div class="grid grid-cols-2 gap-3 mt-6 lg:grid-cols-4">
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Requests</span>
          <span class="block text-lg font-bold font-mono text-white">{{ performanceSummary.requests.toLocaleString() }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">TTFT p50</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP50) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">TTFT p95</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP95) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">TTFT p99</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP99) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Errors</span>
          <span class="block text-lg font-bold font-mono text-white">{{ performanceSummary.errors.toLocaleString() }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Output speed p50</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTokPerSec(performanceSummary.tpotUsP50) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Output speed p95</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTokPerSec(performanceSummary.tpotUsP95) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Output speed p99</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTokPerSec(performanceSummary.tpotUsP99) }}</span>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-5 mt-6 pt-5 border-t border-white/5 lg:grid-cols-2">
        <div v-for="table in [
          { key: 'model' as const, label: 'By Model', rows: overview.modelRows, header: 'Model' },
          { key: 'upstream' as const, label: 'By Upstream', rows: overview.upstreamRows, header: 'Upstream' },
          { key: 'runtimeLocation' as const, label: 'By Region', rows: overview.runtimeRows, header: 'Region' },
          { key: 'operation' as const, label: 'By Operation', rows: overview.operationRows, header: 'Operation' },
          { key: 'userId' as const, label: 'By User', rows: overview.userRows, header: 'User' },
          { key: 'keyId' as const, label: 'By API Key', rows: overview.keyRows, header: 'API Key' },
        ]" :key="table.key" v-show="table.rows.length > 0">
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
                <tr v-for="row in sortedRows(table.rows, table.key)" :key="row.group">
                  <td class="px-3 py-2 text-gray-300">{{ resolveGroupName(row.group, table.key) }}</td>
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
