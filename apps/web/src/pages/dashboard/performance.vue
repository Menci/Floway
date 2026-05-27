<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi as callApiForLoader, useApi as useApiForLoader } from '../../api/client.ts';
import { dashboardRangeQuery as dashboardRangeQueryForLoader } from '../../components/charts/dashboard-chart.ts';

interface LoaderPerformanceRecord {
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

interface LoaderOverviewResponse {
  series: LoaderPerformanceRecord[];
  summaryRows: LoaderPerformanceRecord[];
  modelRows: LoaderPerformanceRecord[];
  runtimeRows: LoaderPerformanceRecord[];
}

export const usePerformancePageData = defineBasicLoader(async () => {
  const api = useApiForLoader();
  const { start, end, bucket } = dashboardRangeQueryForLoader('today');
  const { data } = await callApiForLoader<LoaderOverviewResponse>(() => api.api.performance.overview.$get({
    query: { start, end, bucket, metric_scope: 'request_total', timezone_offset_minutes: String(new Date().getTimezoneOffset()) },
  }));
  return data ?? { series: [], summaryRows: [], modelRows: [], runtimeRows: [] };
});
</script>

<script setup lang="ts">
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';
import type { TooltipItem } from 'chart.js';
import type { ChartConfiguration } from 'chart.js/auto';
import { computed, ref, watch, watchEffect } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import { chartColor, chartFont, chartXAxisTick, dashboardBuckets, dashboardRangeQuery, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import ChartCanvas from '../../components/charts/ChartCanvas.vue';

interface DisplayRecord {
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
interface OverviewResponse {
  series: DisplayRecord[];
  summaryRows: DisplayRecord[];
  modelRows: DisplayRecord[];
  runtimeRows: DisplayRecord[];
}

type Range = DashboardRange;
type Scope = 'request_total' | 'upstream_success';
type ChartView = 'model' | 'percentile';
type PercentileKey = 'p50Ms' | 'p95Ms' | 'p99Ms';

const api = useApi();
const initialOverview = usePerformancePageData();

const performanceRange = ref<Range>('today');
const loadedPerformanceRange = ref<Range>('today');
const performanceMetricScope = ref<Scope>('request_total');
const performanceChartView = ref<ChartView>('model');
const performancePercentile = ref<PercentileKey>('p95Ms');
const performanceModel = ref<string>('');

const series = ref<DisplayRecord[]>(initialOverview.data.value.series);
const overview = ref<OverviewResponse | null>(initialOverview.data.value);
const performanceLoading = ref(false);
let performanceRequestId = 0;

const switchPerformanceRange = (r: Range) => {
  if (performanceRange.value === r) return;
  performanceRange.value = r;
};
const switchPerformanceMetricScope = (s: Scope) => {
  if (performanceMetricScope.value === s) return;
  performanceMetricScope.value = s;
};
const switchPerformanceChartView = (v: ChartView) => {
  if (performanceChartView.value === v) return;
  performanceChartView.value = v;
};
const switchPerformancePercentile = (p: PercentileKey) => { performancePercentile.value = p; };

const load = async () => {
  const requestId = ++performanceRequestId;
  const requestedRange = performanceRange.value;
  const requestedScope = performanceMetricScope.value;
  performanceLoading.value = true;
  const { start, end, bucket } = dashboardRangeQuery(requestedRange);
  const { data } = await callApi<OverviewResponse>(() => api.api.performance.overview.$get({
    query: { start, end, bucket, metric_scope: requestedScope, timezone_offset_minutes: String(new Date().getTimezoneOffset()) },
  }));
  if (requestId !== performanceRequestId || performanceRange.value !== requestedRange || performanceMetricScope.value !== requestedScope) return;
  if (data) {
    overview.value = data;
    series.value = data.series;
    loadedPerformanceRange.value = requestedRange;
  }
  performanceLoading.value = false;
};

watch([performanceRange, performanceMetricScope], load);

const seriesValue = (r: DisplayRecord, p: PercentileKey) => r[p];

const performancePercentileLabel = computed(() => {
  switch (performancePercentile.value) {
  case 'p50Ms': return 'p50';
  case 'p95Ms': return 'p95';
  case 'p99Ms': return 'p99';
  }
});

const performanceModelOptions = computed(() => {
  const ids = new Set<string>();
  for (const r of series.value) ids.add(r.group);
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

const formatDurationMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const chartConfig = computed<ChartConfiguration<'line'>>(() => {
  const { keys: bucketKeys, labels } = dashboardBuckets(loadedPerformanceRange.value);

  const datasets = performanceChartView.value === 'model'
    ? (() => {
      const groups = new Map<string, Map<string, number | null>>();
      for (const r of series.value) {
        const inner = groups.get(r.group) ?? new Map<string, number | null>();
        inner.set(r.bucket, seriesValue(r, performancePercentile.value));
        groups.set(r.group, inner);
      }
      return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, byBucket], i) => {
        const color = chartColor(i);
        return {
          label: group,
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
      const byBucket = new Map(series.value.filter(r => r.group === performanceModel.value).map(r => [r.bucket, seriesValue(r, p)]));
      const color = chartColor(i);
      return {
        label: p.replace('Ms', ''),
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
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#9e9e9e', font: { size: 11, family: chartFont.sans }, boxWidth: 12, padding: 16, usePointStyle: true, pointStyle: 'circle' },
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
          callbacks: { label: (ctx: TooltipItem<'line'>) => `${ctx.dataset.label}: ${formatDurationMs(Number(ctx.parsed.y))}` },
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
          ticks: { color: '#9e9e9e', font: { size: 10, family: chartFont.mono }, callback: v => formatDurationMs(Number(v)) },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  };
});

const performanceSummary = computed(() => {
  const row = overview.value?.summaryRows[0];
  return {
    requests: row?.requests ?? 0,
    errors: row?.errors ?? 0,
    avgMs: row?.avgMs ?? null,
    p50Ms: row?.p50Ms ?? null,
    p95Ms: row?.p95Ms ?? null,
    p99Ms: row?.p99Ms ?? null,
  };
});

const performanceModelRows = computed(() => overview.value?.modelRows ?? []);
const performanceRuntimeRows = computed(() => overview.value?.runtimeRows ?? []);

const formatDuration = formatDurationMs;
</script>

<template>
  <div>
    <div class="glass-card p-6 animate-in">
      <div class="flex flex-col gap-4 mb-6 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex items-center gap-3">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Performance</span>
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
              @click="switchPerformanceMetricScope('request_total')"
            >
              Total
            </button>
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceMetricScope === 'upstream_success' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="switchPerformanceMetricScope('upstream_success')"
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
              @click="switchPerformanceChartView('model')"
            >
              By Model
            </button>
            <button
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="performanceChartView === 'percentile' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="switchPerformanceChartView('percentile')"
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
              @click="switchPerformancePercentile(p)"
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
              @click="switchPerformanceRange(r)"
            >
              {{ r === 'today' ? 'Last Day' : r === '7d' ? '7 Days' : '30 Days' }}
            </button>
          </OverlayScrollbars>
        </div>
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
                <tr v-for="row in performanceModelRows" :key="row.group">
                  <td class="px-3 py-2 text-gray-300">{{ row.group }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ row.requests.toLocaleString() }}</td>
                  <td class="px-3 py-2 text-right font-mono text-white">{{ formatDuration(row[performancePercentile]) }}</td>
                  <td class="px-3 py-2 text-right font-mono text-gray-400">{{ formatDuration(row.avgMs) }}</td>
                </tr>
              </tbody>
            </table>
          </OverlayScrollbars>
        </div>
        <div v-if="performanceRuntimeRows.length > 0">
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
                <tr v-for="row in performanceRuntimeRows" :key="row.group">
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
