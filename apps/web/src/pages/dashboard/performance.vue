<script lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core';
import type { TooltipItem } from 'chart.js';
import type { ChartConfiguration } from 'chart.js/auto';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, shallowRef, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  buildOverviewQuery,
  emptyDisplayRecord,
  emptyOverview,
  parseUrlState,
  serializeUrlState,
  sortRows,
  type GroupBy,
  type MetricView,
  type PercentileKey,
  type PerformanceOverviewResponse,
  type PerformanceView,
  type SortDir,
  type TableSortKey,
  type UrlState,
} from './performance-helpers.ts';
import { callApi, useApi } from '../../api/client.ts';
import ChartCanvas from '../../components/charts/ChartCanvas.vue';
import ChartSeriesControls from '../../components/charts/ChartSeriesControls.vue';
import { chartColor, chartColorByName, chartFont, chartXAxisTick, dashboardBuckets, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import { applySeriesSelection, chartEventsWithDoubleClick, chartSeriesIds, createSeriesIsolation, handleLegendClick } from '../../components/charts/series-selection.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { useAuthStore } from '../../stores/auth.ts';
import type { PerformanceDisplayRecord } from '@floway-dev/gateway/control-plane/performance/aggregate';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

export const usePerformancePageData = defineBasicLoader('/dashboard/performance', async route => {
  const api = useApi();
  const auth = useAuthStore();
  const view: PerformanceView = auth.canViewGlobalTelemetry ? 'all-by-user' : 'self-by-key';
  const initial = parseUrlState(route.query);
  const query = buildOverviewQuery(initial, view, Date.now());
  // Load upstream names in parallel with the perf overview so By-Upstream tables
  // and chart legends can resolve upstream ids to human-readable names. Store is
  // module-scoped, so this is a no-op when the user has already visited Settings.
  // The setup script below owns the store handle; here it's touched purely for
  // its side effect of populating that shared cache.
  const [overviewRes] = await Promise.all([
    callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({ query })),
    useUpstreamsStore().upstreams.value
      ? Promise.resolve()
      : useUpstreamsStore().load().catch(err => {
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
// was captured when the URL was minted (bookmark / share). The URL-sync
// watchEffect below writes changes back so refreshing preserves them.
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
// the new one. Reset so the new view starts fully visible. The same switch
// also hides any filter dropdown whose dimension is now the group-by axis
// (and the User + API Key pair, which hides together whenever either is the
// axis) — mirror the template's v-if guards so no invisible filter keeps
// silently narrowing the dataset. The sync-to-URL watchEffect drops the
// corresponding query params automatically once each field is at its default.
watch(performanceGroupBy, groupBy => {
  hiddenPerformanceSeries.value.clear();
  if (groupBy === 'model') filterModel.value = '';
  if (groupBy === 'upstream') filterUpstream.value = '';
  if (groupBy === 'operation') filterOperation.value = '';
  if (groupBy === 'runtimeLocation') filterRuntime.value = '';
  if (groupBy === 'userId' || groupBy === 'keyId') {
    filterUserId.value = '';
    filterKeyId.value = '';
  }
});

// Background tabs shouldn't burn backend cycles running the 6-way overview
// aggregation every 60s while nobody's looking. Gate the poll on document
// visibility and resume the loop as soon as the user comes back. `resume()`
// only re-arms the interval; without an immediate fetch a tab that came
// back after 10 minutes would keep showing stale data for up to 60s, so
// force a load on every visible-again transition.
const { pause: pausePoll, resume: resumePoll } = useIntervalFn(() => { void load(); }, 60_000);
const documentVisibility = useDocumentVisibility();
if (documentVisibility.value !== 'visible') pausePoll();
watch(documentVisibility, v => {
  if (v === 'visible') {
    resumePoll();
    void load();
  } else {
    pausePoll();
  }
});

// Sync every state field to the URL query. `router.replace` (not `push`)
// so click-heavy toggling doesn't flood the browser history.
watchEffect(() => {
  void router.replace({ query: serializeUrlState(currentUrlState()) });
});

// By User is available only with global telemetry access. By API Key is
// always scoped to the actor's own keys, including inside the global view.
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

// Which groupBy axes have server-sorted metadata (so we can assign stable
// slot colors like /usage does). Other axes fall back to name-hash palette.
// Declarative table — new metadata-backed axes only need a lookup entry, not
// a new branch inside colorFor.
const groupByColorSource: Partial<Record<GroupBy, (group: string) => number>> = {
  userId: group => overview.value.users.findIndex(u => String(u.id) === group),
  keyId: group => overview.value.keys.findIndex(k => k.id === group),
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

// Memoise the six per-axis sorts (and their resolved group labels) per
// snapshot so a reactive tick unrelated to the data — e.g. the loading
// spinner opacity toggle — doesn't re-run sortRows on every table.
const breakdownTables = computed(() => [
  { key: 'model' as const, label: 'By Model', rows: overview.value.axes.model, header: 'Model' },
  { key: 'upstream' as const, label: 'By Upstream', rows: overview.value.axes.upstream, header: 'Upstream' },
  { key: 'runtimeLocation' as const, label: 'By Region', rows: overview.value.axes.runtimeLocation, header: 'Region' },
  { key: 'operation' as const, label: 'By Operation', rows: overview.value.axes.operation, header: 'Operation' },
  { key: 'userId' as const, label: 'By User', rows: overview.value.axes.userId, header: 'User' },
  { key: 'keyId' as const, label: 'By API Key', rows: overview.value.axes.keyId, header: 'API Key' },
].map(t => ({ ...t, sortedRows: sortRows(t.rows, tableSortKey.value, tableSortDir.value, t.key, resolveGroupName) })));

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

const formatTpsFromUs = (us: number | null): string =>
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
    const slot = groupByColorSource[performanceGroupBy.value]?.(groupName);
    return slot !== undefined && slot >= 0 ? chartColor(slot) : chartColorByName(groupName);
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

const performanceSummary = computed<PerformanceDisplayRecord>(() => overview.value.axes.none[0] ?? emptyDisplayRecord('all', 'all'));
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
          <span class="block text-lg font-bold font-mono text-white">{{ formatTpsFromUs(performanceSummary.tpotUsP50) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-3 xl:order-4">
          <span class="block text-xs text-gray-500 mb-1">TTFT p95</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP95) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-7 xl:order-7">
          <span class="block text-xs text-gray-500 mb-1">Output speed p95</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTpsFromUs(performanceSummary.tpotUsP95) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-4 xl:order-5">
          <span class="block text-xs text-gray-500 mb-1">TTFT p99</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatMs(performanceSummary.ttftMsP99) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3 lg:order-8 xl:order-8">
          <span class="block text-xs text-gray-500 mb-1">Output speed p99</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatTpsFromUs(performanceSummary.tpotUsP99) }}</span>
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
                  <td class="px-3 py-2 text-right font-mono text-white">{{ formatTpsFromUs(row.tpotUsP95) }}</td>
                </tr>
              </tbody>
            </table>
          </OverlayScrollbars>
        </div>
      </div>
    </div>
  </div>
</template>
