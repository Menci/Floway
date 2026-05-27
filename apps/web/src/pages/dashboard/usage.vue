<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi as callApiForLoader, useApi as useApiForLoader } from '../../api/client.ts';
import { dashboardRangeQuery as dashboardRangeQueryForLoader } from '../../components/charts/dashboard-chart.ts';
import { useModelsStore as useModelsStoreForLoader } from '../../composables/useModels.ts';

interface LoaderUsageResponse {
  records: Array<{
    keyId: string;
    keyName?: string;
    keyCreatedAt?: string;
    model: string;
    hour: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cost: number;
  }>;
  keys: Array<{ id: string; name: string; createdAt: string }>;
  keyColorOrder: string[];
}

interface LoaderSearchUsageResponse {
  records: Array<{ provider: string; keyId: string; keyName?: string; keyCreatedAt?: string; hour: string; requests: number }>;
  keys: Array<{ id: string; name: string; createdAt: string }>;
  keyColorOrder: string[];
  activeProvider: string;
}

export const useUsagePageData = defineBasicLoader(async () => {
  const api = useApiForLoader();
  const { start, end } = dashboardRangeQueryForLoader('today');
  const [usageRes, searchRes] = await Promise.all([
    callApiForLoader<LoaderUsageResponse>(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1' } })),
    callApiForLoader<LoaderSearchUsageResponse>(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1' } })),
    useModelsStoreForLoader().load(),
  ]);
  return {
    usage: usageRes.data ?? { records: [], keys: [], keyColorOrder: [] },
    search: searchRes.data ?? { records: [], keys: [], keyColorOrder: [], activeProvider: 'disabled' },
  };
});
</script>

<script setup lang="ts">
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';
import type { TooltipItem } from 'chart.js';
import type { ChartConfiguration } from 'chart.js/auto';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import { bucketKeyForUtcHour, chartColor, chartFont, chartXAxisTick, dashboardBuckets, dashboardRangeQuery, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import ChartCanvas from '../../components/charts/ChartCanvas.vue';
import UsageSummaryMetric from '../../components/usage/UsageSummaryMetric.vue';
import { useModelsStore } from '../../composables/useModels.ts';

interface DisplayUsageRecord {
  keyId: string;
  keyName?: string;
  keyCreatedAt?: string;
  model: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
}
interface UsageResponse {
  records: DisplayUsageRecord[];
  keys: Array<{ id: string; name: string; createdAt: string }>;
  keyColorOrder: string[];
}
interface SearchUsageRecord { provider: string; keyId: string; keyName?: string; keyCreatedAt?: string; hour: string; requests: number }
interface SearchUsageResponse {
  records: SearchUsageRecord[];
  keys: Array<{ id: string; name: string; createdAt: string }>;
  keyColorOrder: string[];
  activeProvider: string;
}

type Metric =
  | 'requests' | 'cost'
  | 'total' | 'input' | 'output' | 'prefill'
  | 'cached' | 'cachedRate'
  | 'cacheCreation' | 'cacheHitRate';
type Range = DashboardRange;

const api = useApi();
const initialUsageData = useUsagePageData();
const modelsStore = useModelsStore();

const tokenRange = ref<Range>('today');
const loadedTokenRange = ref<Range>('today');
const tokenChartMetric = ref<Metric>('total');
const redactKeys = ref(false);
const data = ref<UsageResponse | null>(initialUsageData.data.value.usage);
const searchData = ref<SearchUsageResponse | null>(initialUsageData.data.value.search);
const tokenLoading = ref(false);
const searchUsageLoading = ref(false);
let usageRequestId = 0;

const load = async () => {
  const requestId = ++usageRequestId;
  const requestedRange = tokenRange.value;
  tokenLoading.value = true;
  searchUsageLoading.value = true;
  const { start, end } = dashboardRangeQuery(requestedRange);
  try {
    const [usageRes, searchRes] = await Promise.all([
      callApi<UsageResponse>(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1' } })),
      callApi<SearchUsageResponse>(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1' } })),
    ]);
    if (requestId !== usageRequestId || tokenRange.value !== requestedRange) return;
    if (usageRes.data) data.value = usageRes.data;
    if (searchRes.data) searchData.value = searchRes.data;
    loadedTokenRange.value = requestedRange;
  } finally {
    if (requestId === usageRequestId) {
      tokenLoading.value = false;
      searchUsageLoading.value = false;
    }
  }
};

const switchTokenRange = (r: Range) => {
  if (tokenRange.value === r) return;
  tokenRange.value = r;
};
const switchTokenChartMetric = (m: string) => { tokenChartMetric.value = m as Metric; };

watch(tokenRange, load);

const tokenSummary = computed(() => {
  const records = data.value?.records ?? [];
  let requests = 0, cost = 0, input = 0, output = 0, cacheRead = 0, cacheCreation = 0;
  for (const r of records) {
    requests += r.requests;
    cost += r.cost;
    input += r.inputTokens;
    output += r.outputTokens;
    cacheRead += r.cacheReadTokens;
    cacheCreation += r.cacheCreationTokens;
  }
  return {
    requests, cost, input, output, cacheRead, cacheCreation,
    total: input + output,
    prefill: input - cacheRead,
  };
});

const formatInputRate = (cached: number, input: number) => {
  if (input <= 0) return '—';
  const pct = (cached / input) * 100;
  return `${pct.toFixed(1)}%`;
};
const formatHitRate = (cached: number, created: number) => {
  const denom = cached + created;
  if (denom <= 0) return '—';
  return `${((cached / denom) * 100).toFixed(1)}%`;
};

const buckets = computed(() => dashboardBuckets(loadedTokenRange.value));

const TOKEN_CHART_METRICS: Record<Metric, { label: string; kind: 'count' | 'cost' | 'tokens' | 'percent' }> = {
  requests: { label: 'Requests', kind: 'count' },
  cost: { label: 'Est. Cost', kind: 'cost' },
  total: { label: 'Total Tokens', kind: 'tokens' },
  input: { label: 'Input Tokens', kind: 'tokens' },
  output: { label: 'Output Tokens', kind: 'tokens' },
  cached: { label: 'Cached Input', kind: 'tokens' },
  cachedRate: { label: 'Cached Rate', kind: 'percent' },
  prefill: { label: 'Prefill Input', kind: 'tokens' },
  cacheCreation: { label: 'Cache Write', kind: 'tokens' },
  cacheHitRate: { label: 'Cache Hit Rate', kind: 'percent' },
};

const isPercentMetric = (metric: Metric) => TOKEN_CHART_METRICS[metric].kind === 'percent';

const metricValue = (r: DisplayUsageRecord, metric: Metric): number => {
  switch (metric) {
  case 'requests': return r.requests;
  case 'cost': return r.cost;
  case 'total': return r.inputTokens + r.outputTokens;
  case 'input': return r.inputTokens;
  case 'output': return r.outputTokens;
  case 'prefill': return r.inputTokens - r.cacheReadTokens;
  case 'cached': return r.cacheReadTokens;
  case 'cacheCreation': return r.cacheCreationTokens;
  case 'cachedRate':
  case 'cacheHitRate':
    return 0;
  }
};

const redactKeyLabel = (full: string, id: string) => redactKeys.value ? id.slice(0, 6) : full;

interface KeyMeta {
  name?: string;
  createdAt?: string;
}

interface TokenDetail {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cost: number;
}

interface ChartEntry {
  id: string;
  label: string;
  colorSlot: number;
}

const compareKeyIds = (a: string, b: string, keyMetaMap: Map<string, KeyMeta>) => {
  const am = keyMetaMap.get(a);
  const bm = keyMetaMap.get(b);
  if (am?.createdAt && bm?.createdAt && am.createdAt !== bm.createdAt) return am.createdAt.localeCompare(bm.createdAt);
  if (am?.createdAt !== bm?.createdAt) return am?.createdAt ? -1 : 1;
  return a.localeCompare(b);
};

const keyColorSlots = (colorOrder: readonly string[]) => {
  const explicitSlotById = new Map<string, number>();
  const futureSlotByIndex = new Map<number, number>();
  let maxFutureIndex = 0;
  for (let i = 0; i < colorOrder.length; i++) {
    const token = colorOrder[i]!;
    const futureMatch = token.match(/^future-(\d+)$/);
    if (futureMatch) {
      const futureIndex = Number(futureMatch[1]);
      futureSlotByIndex.set(futureIndex, i);
      maxFutureIndex = Math.max(maxFutureIndex, futureIndex);
    } else {
      explicitSlotById.set(token, i);
    }
  }
  return { explicitSlotById, futureSlotByIndex, maxFutureIndex };
};

const futureColorSlot = (futureIndex: number, colorOrderLength: number, futureSlotByIndex: Map<number, number>, maxFutureIndex: number) =>
  futureSlotByIndex.get(futureIndex) ?? colorOrderLength + futureIndex - maxFutureIndex - 1;

const keyChartEntries = (
  presentKeyIds: readonly string[],
  keyMetaMap: Map<string, KeyMeta>,
  keyIdsForOrder: readonly string[],
  colorOrder: readonly string[],
): ChartEntry[] => {
  const present = new Set(presentKeyIds);
  const { explicitSlotById, futureSlotByIndex, maxFutureIndex } = keyColorSlots(colorOrder);
  const futureKeyIds = [...new Set([...keyIdsForOrder, ...presentKeyIds])]
    .filter(keyId => !explicitSlotById.has(keyId))
    .sort((a, b) => compareKeyIds(a, b, keyMetaMap));
  const futureSlotByKeyId = new Map(
    futureKeyIds.map((keyId, i) => [keyId, futureColorSlot(i + 1, colorOrder.length, futureSlotByIndex, maxFutureIndex)]),
  );
  return [...present]
    .map(keyId => ({ id: keyId, label: redactKeyLabel(keyMetaMap.get(keyId)?.name ?? keyId.slice(0, 8), keyId), colorSlot: explicitSlotById.get(keyId) ?? futureSlotByKeyId.get(keyId) }))
    .filter((entry): entry is ChartEntry => entry.colorSlot !== undefined)
    .sort((a, b) => a.colorSlot - b.colorSlot || compareKeyIds(a.id, b.id, keyMetaMap));
};

const modelChartEntries = (presentModelIds: readonly string[]): ChartEntry[] => {
  const present = new Set(presentModelIds);
  const known = modelsStore.models.value?.map(m => m.id) ?? [];
  return [...new Set([...known, ...presentModelIds])]
    .sort()
    .map((id, colorSlot) => ({ id, label: id, colorSlot }))
    .filter(entry => present.has(entry.id));
};

const tokenDetailMetricValue = (detail: TokenDetail, metric: Metric): number | null => {
  if (metric === 'cacheHitRate') {
    const total = detail.cacheRead + detail.cacheCreation;
    return total > 0 ? (detail.cacheRead / total) * 100 : null;
  }
  if (metric === 'cachedRate') return detail.input > 0 ? (detail.cacheRead / detail.input) * 100 : null;
  return null;
};

const emptyDetail = (): TokenDetail => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 });

const aggregateTokenRecords = (records: readonly DisplayUsageRecord[], groupKey: 'keyId' | 'model', metric: Metric) => {
  const { keys: bucketKeys, labels } = buckets.value;
  const values = new Map<string, Map<string, number | null>>();
  const details = new Map<string, Map<string, TokenDetail>>();
  const presentGroups = new Set<string>();
  for (const key of bucketKeys) {
    values.set(key, new Map());
    details.set(key, new Map());
  }
  for (const r of records) {
    const bucket = bucketKeyForUtcHour(loadedTokenRange.value, r.hour);
    if (!values.has(bucket)) continue;
    const group = r[groupKey];
    presentGroups.add(group);
    const bucketDetails = details.get(bucket)!;
    const detail = bucketDetails.get(group) ?? emptyDetail();
    detail.requests += r.requests;
    detail.input += r.inputTokens;
    detail.output += r.outputTokens;
    detail.cacheRead += r.cacheReadTokens;
    detail.cacheCreation += r.cacheCreationTokens;
    detail.cost += r.cost;
    bucketDetails.set(group, detail);
    if (!isPercentMetric(metric)) {
      const bucketValues = values.get(bucket)!;
      bucketValues.set(group, (bucketValues.get(group) ?? 0) + metricValue(r, metric));
    }
  }
  if (isPercentMetric(metric)) {
    for (const [bucket, bucketDetails] of details) {
      const bucketValues = values.get(bucket)!;
      for (const [group, detail] of bucketDetails) bucketValues.set(group, tokenDetailMetricValue(detail, metric));
    }
  }
  return { bucketKeys, labels, values, details, presentGroups };
};

const formatTokenCount = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));

const formatTokenChartAxisValue = (value: number, metric: Metric) => {
  const kind = TOKEN_CHART_METRICS[metric].kind;
  if (kind === 'percent') return `${value.toFixed(0)}%`;
  if (kind === 'count') return Math.round(value).toLocaleString();
  if (kind === 'cost') return formatCost(value);
  return formatTokenCount(value);
};

const tooltipHeader = (labelWidth: number) =>
  `  ${''.padEnd(labelWidth + 1)}${'Req'.padStart(5)}  ${'Cost'.padStart(9)}  ${'Total'.padStart(7)}  ${'Cached'.padStart(7)}  ${'Cached%'.padStart(8)}  ${'Prefill'.padStart(7)}  ${'Output'.padStart(7)}  ${'Hit%'.padStart(7)}`;

const tooltipRow = (label: string, labelWidth: number, detail: TokenDetail) => {
  const cached = detail.cacheRead;
  const prefill = detail.input - cached;
  return `${label.padEnd(labelWidth + 1)}${String(detail.requests).padStart(5)}  ${formatCost(detail.cost).padStart(9)}  ${formatTokenCount(detail.input + detail.output).padStart(7)}  ${formatTokenCount(cached).padStart(7)}  ${formatInputRate(cached, detail.input).padStart(8)}  ${formatTokenCount(prefill).padStart(7)}  ${formatTokenCount(detail.output).padStart(7)}  ${formatHitRate(detail.cacheRead, detail.cacheCreation).padStart(7)}`;
};

const keyMetadataForTokenRecords = (records: readonly DisplayUsageRecord[], metadata: readonly { id: string; name: string; createdAt: string }[]) => {
  const map = new Map<string, KeyMeta>();
  for (const key of metadata) map.set(key.id, { name: key.name, createdAt: key.createdAt });
  for (const record of records) {
    const prev = map.get(record.keyId);
    map.set(record.keyId, { name: record.keyName ?? prev?.name, createdAt: record.keyCreatedAt ?? prev?.createdAt });
  }
  return map;
};

const buildStackedConfig = (groupKey: 'keyId' | 'model'): ChartConfiguration<'line'> => {
  const records = data.value?.records ?? [];
  const metric = tokenChartMetric.value;
  const isPercent = isPercentMetric(metric);
  const { bucketKeys, labels, values, details, presentGroups } = aggregateTokenRecords(records, groupKey, metric);
  const entries = groupKey === 'keyId'
    ? keyChartEntries([...presentGroups], keyMetadataForTokenRecords(records, data.value?.keys ?? []), data.value?.keys.map(k => k.id) ?? [...presentGroups], data.value?.keyColorOrder ?? [])
    : modelChartEntries([...presentGroups]);
  const labelWidth = entries.reduce((max, entry) => Math.max(max, entry.label.length), 0);
  return {
    type: 'line',
    data: {
      labels,
      datasets: entries.map(entry => {
        const color = chartColor(entry.colorSlot);
        return {
          label: entry.label,
          data: bucketKeys.map(k => values.get(k)?.get(entry.id) ?? (isPercent ? null : 0)),
          borderColor: color,
          backgroundColor: `${color}40`,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.3,
          fill: isPercent ? false : 'stack',
          spanGaps: isPercent,
        };
      }),
    },
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
          filter: item => item.parsed.y !== null && (isPercent || item.parsed.y > 0),
          itemSort: (a, b) => Number(b.parsed.y ?? 0) - Number(a.parsed.y ?? 0),
          callbacks: {
            beforeBody: items => items.length ? tooltipHeader(labelWidth) : [],
            label: (ctx: TooltipItem<'line'>) => {
              const bucket = bucketKeys[ctx.dataIndex];
              const entry = entries[ctx.datasetIndex];
              const detail = bucket && entry ? details.get(bucket)?.get(entry.id) : undefined;
              if (!entry || !detail) return `${ctx.dataset.label}: ${formatTokenChartAxisValue(Number(ctx.parsed.y ?? 0), metric)}`;
              return tooltipRow(String(ctx.dataset.label ?? ''), labelWidth, detail);
            },
          },
        },
      },
      scales: {
        x: {
          stacked: !isPercent,
          ticks: { color: '#9e9e9e', maxRotation: 45, font: { size: 10, family: chartFont.sans }, callback: chartXAxisTick(bucketKeys, labels, loadedTokenRange.value === '7d') },
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
        y: {
          stacked: !isPercent,
          beginAtZero: true,
          suggestedMax: isPercent ? 100 : undefined,
          title: { display: true, text: TOKEN_CHART_METRICS[metric].label, color: '#9e9e9e', font: { size: 10, family: chartFont.sans } },
          ticks: { color: '#9e9e9e', font: { size: 10, family: chartFont.mono }, callback: value => formatTokenChartAxisValue(Number(value), metric) },
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  };
};

const byKeyConfig = computed(() => buildStackedConfig('keyId'));
const byModelConfig = computed(() => buildStackedConfig('model'));

const searchUsageActiveProvider = computed(() => {
  return searchData.value?.activeProvider ?? 'disabled';
});

const searchByKeyConfig = computed<ChartConfiguration<'line'>>(() => {
  const records = searchData.value?.records ?? [];
  const { keys: bucketKeys, labels } = buckets.value;
  const groups = new Map<string, Map<string, number>>();
  const presentGroups = new Set<string>();
  const meta = new Map<string, KeyMeta>();
  for (const key of searchData.value?.keys ?? []) meta.set(key.id, { name: key.name, createdAt: key.createdAt });
  for (const r of records) {
    if (r.provider !== searchUsageActiveProvider.value) continue;
    meta.set(r.keyId, { name: r.keyName ?? meta.get(r.keyId)?.name, createdAt: r.keyCreatedAt ?? meta.get(r.keyId)?.createdAt });
    const inner = groups.get(r.keyId) ?? new Map<string, number>();
    const bk = bucketKeyForUtcHour(loadedTokenRange.value, r.hour);
    if (!bucketKeys.includes(bk)) continue;
    inner.set(bk, (inner.get(bk) ?? 0) + r.requests);
    groups.set(r.keyId, inner);
    presentGroups.add(r.keyId);
  }
  const entries = keyChartEntries([...presentGroups], meta, searchData.value?.keys.map(k => k.id) ?? [...presentGroups], searchData.value?.keyColorOrder ?? []);
  return {
    type: 'line',
    data: {
      labels,
      datasets: entries.map(entry => {
        const color = chartColor(entry.colorSlot);
        return {
          label: entry.label,
          data: bucketKeys.map(k => groups.get(entry.id)?.get(k) ?? 0),
          borderColor: color,
          backgroundColor: `${color}40`,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.3,
          fill: 'stack',
          spanGaps: false,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9e9e9e', font: { size: 11, family: chartFont.sans }, boxWidth: 12, padding: 16, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          backgroundColor: 'rgba(12,16,21,0.95)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#e0e0e0',
          bodyColor: '#b0bec5',
          padding: 12,
          bodyFont: { family: chartFont.mono, size: 11 },
          filter: item => item.parsed.y !== null && item.parsed.y > 0,
          callbacks: { label: (ctx: TooltipItem<'line'>) => `${ctx.dataset.label}: ${Math.round(Number(ctx.parsed.y)).toLocaleString()}` },
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: '#9e9e9e', maxRotation: 45, font: { size: 10, family: chartFont.sans }, callback: chartXAxisTick(bucketKeys, labels, loadedTokenRange.value === '7d') }, grid: { color: 'rgba(255,255,255,0.04)' }, border: { color: 'rgba(255,255,255,0.06)' } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Search Requests', color: '#9e9e9e', font: { size: 10, family: chartFont.sans } }, ticks: { color: '#9e9e9e', font: { size: 10, family: chartFont.mono }, callback: value => Math.round(Number(value)).toLocaleString() }, grid: { color: 'rgba(255,255,255,0.04)' }, border: { color: 'rgba(255,255,255,0.06)' } },
      },
    },
  };
});

const formatCost = (v: number) => {
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  if (v > 0) return `$${v.toFixed(4)}`;
  return '$0';
};
</script>

<template>
  <div>
    <div class="glass-card p-6 animate-in">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div class="flex items-center gap-3">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Token Usage — By Key</span>
          <button
            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md p-1 transition-colors text-gray-600 hover:text-gray-400 hover:bg-white/[0.04]"
            aria-label="Toggle key name redaction"
            title="Redact key names"
            @click="redactKeys = !redactKeys"
          >
            <svg v-if="!redactKeys" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          </button>
          <Spinner v-if="tokenLoading" class="h-3.5 w-3.5 text-gray-500" />
        </div>
        <OverlayScrollbars
          class="max-w-full rounded-lg bg-surface-800"
          content-class="flex items-center gap-1 p-0.5"
          no-tabindex
        >
          <button
            v-for="r in (['today', '7d', '30d'] as const)"
            :key="r"
            class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
            :class="tokenRange === r ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            @click="switchTokenRange(r)"
          >
            {{ r === 'today' ? 'Last Day' : r === '7d' ? '7 Days' : '30 Days' }}
          </button>
        </OverlayScrollbars>
      </div>

      <div style="height: 320px; position: relative;">
        <ChartCanvas :config="byKeyConfig" />
      </div>

      <div class="mt-6 pt-5 border-t border-white/5">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4 block">By Model</span>
        <div style="height: 320px; position: relative;">
          <ChartCanvas :config="byModelConfig" />
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-6 pt-5 border-t border-white/5">
        <div class="grid grid-cols-2 lg:grid-cols-1 gap-2">
          <UsageSummaryMetric metric="requests" label="Requests" :active="tokenChartMetric === 'requests'" :value="tokenSummary.requests.toLocaleString()" @select="switchTokenChartMetric" />
          <UsageSummaryMetric metric="cost" label="Est. Cost" :active="tokenChartMetric === 'cost'" :value="formatCost(tokenSummary.cost)" @select="switchTokenChartMetric" />
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-1 gap-2">
          <UsageSummaryMetric metric="total" label="Total Tokens" :active="tokenChartMetric === 'total'" :value="tokenSummary.total.toLocaleString()" @select="switchTokenChartMetric" />
          <UsageSummaryMetric metric="output" label="Output Tokens" :active="tokenChartMetric === 'output'" :value="tokenSummary.output.toLocaleString()" @select="switchTokenChartMetric" />
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-1 gap-2">
          <UsageSummaryMetric metric="input" label="Input Tokens" :active="tokenChartMetric === 'input'" :value="tokenSummary.input.toLocaleString()" @select="switchTokenChartMetric" />
          <UsageSummaryMetric metric="prefill" label="Prefill Input" :active="tokenChartMetric === 'prefill'" :value="tokenSummary.prefill.toLocaleString()" @select="switchTokenChartMetric" />
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-1 gap-2">
          <UsageSummaryMetric metric="cached" label="Cached Input" :active="tokenChartMetric === 'cached'" :value="tokenSummary.cacheRead.toLocaleString()" @select="switchTokenChartMetric" />
          <UsageSummaryMetric metric="cachedRate" label="Cached Rate" :active="tokenChartMetric === 'cachedRate'" :value="formatInputRate(tokenSummary.cacheRead, tokenSummary.input)" @select="switchTokenChartMetric" />
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-1 gap-2">
          <UsageSummaryMetric metric="cacheCreation" label="Cache Write" :active="tokenChartMetric === 'cacheCreation'" :value="tokenSummary.cacheCreation.toLocaleString()" @select="switchTokenChartMetric" />
          <UsageSummaryMetric metric="cacheHitRate" label="Cache Hit Rate" :active="tokenChartMetric === 'cacheHitRate'" :value="formatHitRate(tokenSummary.cacheRead, tokenSummary.cacheCreation)" @select="switchTokenChartMetric" />
        </div>
      </div>

      <div v-if="searchUsageActiveProvider !== 'disabled'" class="mt-6 pt-5 border-t border-white/5">
        <div class="flex items-center gap-3 mb-4">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest block">Search Usage — Per Key</span>
          <Spinner v-if="searchUsageLoading" class="h-3.5 w-3.5 text-gray-500" />
        </div>
        <div style="height: 320px; position: relative;">
          <ChartCanvas :config="searchByKeyConfig" />
        </div>
      </div>
    </div>
  </div>
</template>
