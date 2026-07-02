<script lang="ts">
import { useIntervalFn } from '@vueuse/core';
import type { TooltipItem } from 'chart.js';
import type { ChartConfiguration } from 'chart.js/auto';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, watch, watchEffect } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import ChartCanvas from '../../components/charts/ChartCanvas.vue';
import ChartSeriesControls from '../../components/charts/ChartSeriesControls.vue';
import { chartColor, chartFont, chartXAxisTick, dashboardBuckets, dashboardRangeQuery, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import { applySeriesSelection, chartEventsWithDoubleClick, chartSeriesIds, createSeriesIsolation, handleLegendClick } from '../../components/charts/series-selection.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

type PerformanceView = 'all-by-user' | 'self-by-key';

interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  totalMsSum: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

interface PerformanceOverviewResponse {
  series: PerformanceDisplayRecord[];
  summaryRows: PerformanceDisplayRecord[];
  modelRows: PerformanceDisplayRecord[];
  runtimeRows: PerformanceDisplayRecord[];
}

export const usePerformancePageData = defineBasicLoader(async () => {
  const api = useApi();
  const auth = useAuthStore();
  const view: PerformanceView = auth.canViewGlobalTelemetry ? 'all-by-user' : 'self-by-key';
  const { start, end, bucket } = dashboardRangeQuery('today', Date.now());
  const overviewRes = await callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({
    query: { start, end, bucket, metric_scope: 'request_total', timezone_offset_minutes: String(new Date().getTimezoneOffset()), view },
  }));
  return {
    view,
    overview: overviewRes.data ?? { series: [], summaryRows: [], modelRows: [], runtimeRows: [] },
    error: overviewRes.error ? overviewRes.error.message : null,
  };
});
</script>

<script setup lang="ts">
type Scope = 'request_total' | 'upstream_success';
type ChartView = 'model' | 'percentile';
type PercentileKey = 'p50Ms' | 'p95Ms' | 'p99Ms';

const api = useApi();
const auth = useAuthStore();
const initialOverview = usePerformancePageData();

const performanceRange = ref<DashboardRange>('today');
const loadedPerformanceRange = ref<DashboardRange>('today');
// Buckets and the request window are derived from the same `loadedAt` so the
// chart axis stays in lockstep with whichever data snapshot is currently shown.
const loadedAt = ref(Date.now());
const performanceMetricScope = ref<Scope>('request_total');
const performanceChartView = ref<ChartView>('model');
const performancePercentile = ref<PercentileKey>('p95Ms');
const performanceModel = ref<string>('');
const performanceView = ref<PerformanceView>(initialOverview.data.value.view);
const hiddenPerformanceSeries = ref(new Set<string>());

const overview = ref<PerformanceOverviewResponse>(initialOverview.data.value.overview);
const performanceError = ref<string | null>(initialOverview.data.value.error);
const performanceLoading = ref(false);
let performanceRequestId = 0;

const load = async () => {
  const requestId = ++performanceRequestId;
  const requestedRange = performanceRange.value;
  const requestedScope = performanceMetricScope.value;
  const requestedView = performanceView.value;
  const requestedAt = Date.now();
  performanceLoading.value = true;
  const { start, end, bucket } = dashboardRangeQuery(requestedRange, requestedAt);
  const { data, error: err } = await callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({
    query: { start, end, bucket, metric_scope: requestedScope, timezone_offset_minutes: String(new Date().getTimezoneOffset()), view: requestedView },
  }));
  if (requestId !== performanceRequestId || performanceRange.value !== requestedRange || performanceMetricScope.value !== requestedScope || performanceView.value !== requestedView) return;
  performanceLoading.value = false;
  if (err) { performanceError.value = err.message; return; }
  performanceError.value = null;
  overview.value = data;
  loadedPerformanceRange.value = requestedRange;
  loadedAt.value = requestedAt;
};

watch([performanceRange, performanceMetricScope, performanceView], load);
useIntervalFn(() => { void load(); }, 60_000);

const performancePercentileLabel = computed(() => performancePercentile.value.replace('Ms', ''));

const performanceModelOptions = computed(() => {
  const ids = new Set<string>();
  for (const r of overview.value.series) ids.add(r.group);
  return [...ids].sort();
});

watchEffect(() => {
  const options = performanceModelOptions.value;
  if (options.length === 0) {
    performanceModel.value = '';
    return;
  }
  if (!options.includes(performanceModel.value)) performanceModel.value = options[0]!;
});

const performanceSeriesIsolation = createSeriesIsolation();

const formatDuration = (ms: number | null) => {
  if (ms === null) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const chartConfig = computed<ChartConfiguration<'line'>>(() => {
  const { keys: bucketKeys, labels } = dashboardBuckets(loadedPerformanceRange.value, loadedAt.value);

  const datasets = performanceChartView.value === 'model'
    ? (() => {
        const groups = new Map<string, Map<string, number | null>>();
        for (const r of overview.value.series) {
          const inner = groups.get(r.group) ?? new Map<string, number | null>();
          inner.set(r.bucket, r[performancePercentile.value]);
          groups.set(r.group, inner);
        }
        return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, byBucket], i) => {
          const color = chartColor(i);
          return {
            label: group,
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
      })()
    : (['p50Ms', 'p95Ms', 'p99Ms'] as PercentileKey[]).map((p, i) => {
        const byBucket = new Map(overview.value.series.filter(r => r.group === performanceModel.value).map(r => [r.bucket, r[p]]));
        const color = chartColor(i);
        return {
          label: p.replace('Ms', ''),
          seriesId: p,
          hidden: hiddenPerformanceSeries.value.has(p),
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

  const yTitle = performanceChartView.value === 'percentile'
    ? `${performanceModel.value || 'all models'} latency`
    : `${performancePercentileLabel.value} latency`;

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
          callbacks: { label: (ctx: TooltipItem<'line'>) => `${ctx.dataset.label}: ${formatDuration(Number(ctx.parsed.y))}` },
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
          ticks: { color: '#9e9e9e', font: { size: 10, family: chartFont.mono }, callback: v => formatDuration(Number(v)) },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  };
});

const performanceSeriesIds = computed(() => chartSeriesIds(chartConfig.value));

const performanceSummary = computed(() => {
  const row = overview.value.summaryRows[0];
  return {
    requests: row?.requests ?? 0,
    errors: row?.errors ?? 0,
    avgMs: row?.avgMs ?? null,
    p50Ms: row?.p50Ms ?? null,
    p95Ms: row?.p95Ms ?? null,
    p99Ms: row?.p99Ms ?? null,
  };
});
</script>

<template>
  <div>
    <div class="glass-card p-6 animate-in">
      <div class="flex flex-col gap-4 mb-6 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex items-center gap-3">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Performance</span>
          <div v-if="auth.canViewGlobalTelemetry" class="inline-flex rounded-md bg-surface-800 p-0.5" role="tablist">
            <button
              type="button"
              class="px-2 py-1 text-[11px] font-medium rounded transition-colors"
              :class="performanceView === 'all-by-user' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceView = 'all-by-user'"
            >All by user</button>
            <button
              type="button"
              class="px-2 py-1 text-[11px] font-medium rounded transition-colors"
              :class="performanceView === 'self-by-key' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceView = 'self-by-key'"
            >My keys</button>
          </div>
          <Spinner v-if="performanceLoading" class="h-3.5 w-3.5 text-gray-500" />
        </div>
        <div class="flex max-w-full flex-wrap items-center gap-2">
          <OverlayScrollbars
            class="max-w-full rounded-lg bg-surface-800"
            content-class="flex items-center gap-1 p-0.5"
            no-tabindex
          >
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceMetricScope === 'request_total' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceMetricScope = 'request_total'"
            >
              Total
            </button>
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceMetricScope === 'upstream_success' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceMetricScope = 'upstream_success'"
            >
              Upstream
            </button>
          </OverlayScrollbars>
          <OverlayScrollbars
            class="max-w-full rounded-lg bg-surface-800"
            content-class="flex items-center gap-1 p-0.5"
            no-tabindex
          >
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceChartView === 'model' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceChartView = 'model'"
            >
              By Model
            </button>
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceChartView === 'percentile' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceChartView = 'percentile'"
            >
              By Percentile
            </button>
          </OverlayScrollbars>
          <OverlayScrollbars
            v-if="performanceChartView === 'model'"
            class="max-w-full rounded-lg bg-surface-800"
            content-class="flex items-center gap-1 p-0.5"
            no-tabindex
          >
            <button
              v-for="p in (['p50Ms', 'p95Ms', 'p99Ms'] as const)"
              :key="p"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performancePercentile === p ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performancePercentile = p"
            >
              {{ p.replace('Ms', '') }}
            </button>
          </OverlayScrollbars>
          <OverlayScrollbars
            v-if="performanceChartView === 'percentile'"
            class="max-w-full rounded-lg bg-surface-800"
            content-class="flex items-center gap-1 p-0.5"
            no-tabindex
          >
            <select
              v-model="performanceModel"
              class="shrink-0 min-w-44 max-w-64 rounded-md bg-surface-600 px-3 py-1.5 text-xs font-medium text-white outline-none"
              aria-label="Performance model"
            >
              <option v-for="m in performanceModelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </OverlayScrollbars>
          <OverlayScrollbars
            class="max-w-full rounded-lg bg-surface-800"
            content-class="flex items-center gap-1 p-0.5"
            no-tabindex
          >
            <button
              v-for="r in (['today', '7d', '30d'] as const)"
              :key="r"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceRange === r ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="performanceRange = r"
            >
              {{ r === 'today' ? 'Last Day' : r === '7d' ? '7 Days' : '30 Days' }}
            </button>
          </OverlayScrollbars>
        </div>
      </div>

      <div v-if="performanceError" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ performanceError }}
      </div>

      <div class="grid grid-cols-2 gap-3 mb-6 lg:grid-cols-6">
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Successful</span>
          <span class="block text-lg font-bold font-mono text-white">{{ performanceSummary.requests.toLocaleString() }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Errors</span>
          <span class="block text-lg font-bold font-mono text-white">{{ performanceSummary.errors.toLocaleString() }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">Average</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatDuration(performanceSummary.avgMs) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">p50</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatDuration(performanceSummary.p50Ms) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">p95</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatDuration(performanceSummary.p95Ms) }}</span>
        </div>
        <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
          <span class="block text-xs text-gray-500 mb-1">p99</span>
          <span class="block text-lg font-bold font-mono text-white">{{ formatDuration(performanceSummary.p99Ms) }}</span>
        </div>
      </div>

      <div class="mb-2 flex justify-end">
        <ChartSeriesControls label="Performance series selection" @select="applySeriesSelection(hiddenPerformanceSeries, performanceSeriesIds, $event)" />
      </div>
      <div style="height: 340px; position: relative;">
        <ChartCanvas :config="chartConfig" />
      </div>

      <div class="grid grid-cols-1 gap-5 mt-6 pt-5 border-t border-white/5 lg:grid-cols-2">
        <div>
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3 block">By Model</span>
          <OverlayScrollbars class="rounded-md border border-white/5" no-tabindex>
            <table class="w-full text-sm">
              <thead class="bg-surface-800/70 text-xs uppercase tracking-widest text-gray-500">
                <tr>
                  <th class="px-3 py-2 text-left font-medium">Model</th>
                  <th class="px-3 py-2 text-right font-medium">Req</th>
                  <th class="px-3 py-2 text-right font-medium">{{ performancePercentileLabel }}</th>
                  <th class="px-3 py-2 text-right font-medium">Avg</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-for="row in overview.modelRows" :key="row.group">
                  <td class="px-3 py-2 text-gray-300">{{ row.group }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ row.requests.toLocaleString() }}</td>
                  <td class="px-3 py-2 text-right font-mono text-white">{{ formatDuration(row[performancePercentile]) }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ formatDuration(row.avgMs) }}</td>
                </tr>
              </tbody>
            </table>
          </OverlayScrollbars>
        </div>
        <div v-if="overview.runtimeRows.length > 0">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3 block">By Region</span>
          <OverlayScrollbars class="rounded-md border border-white/5" no-tabindex>
            <table class="w-full text-sm">
              <thead class="bg-surface-800/70 text-xs uppercase tracking-widest text-gray-500">
                <tr>
                  <th class="px-3 py-2 text-left font-medium">Region</th>
                  <th class="px-3 py-2 text-right font-medium">Req</th>
                  <th class="px-3 py-2 text-right font-medium">{{ performancePercentileLabel }}</th>
                  <th class="px-3 py-2 text-right font-medium">Avg</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-for="row in overview.runtimeRows" :key="row.group">
                  <td class="px-3 py-2 text-gray-300">{{ row.group }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ row.requests.toLocaleString() }}</td>
                  <td class="px-3 py-2 text-right font-mono text-white">{{ formatDuration(row[performancePercentile]) }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ formatDuration(row.avgMs) }}</td>
                </tr>
              </tbody>
            </table>
          </OverlayScrollbars>
        </div>
      </div>
    </div>
  </div>
</template>
