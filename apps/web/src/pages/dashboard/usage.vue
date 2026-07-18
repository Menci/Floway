<script lang="ts">
import { useIntervalFn } from '@vueuse/core';
import type { TooltipItem } from 'chart.js';
import type { ChartConfiguration } from 'chart.js/auto';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, watch } from 'vue';

import { callApi, useApi, type ApiClient } from '../../api/client.ts';
import type { BillingDimension } from '../../api/types.ts';
import ChartCanvas from '../../components/charts/ChartCanvas.vue';
import ChartSeriesControls from '../../components/charts/ChartSeriesControls.vue';
import { bucketKeyForUtcHour, chartColor, chartFont, chartXAxisTick, dashboardBuckets, dashboardRangeQuery, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import { applySeriesSelection, chartSeriesIds, createSeriesIsolation, handleLegendClick } from '../../components/charts/series-selection.ts';
import UsageSummaryMetric from '../../components/usage/UsageSummaryMetric.vue';
import { useModelsStore } from '../../composables/useModels.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

interface DisplayUsageRecord {
  keyId: string;
  keyName?: string;
  keyCreatedAt?: string;
  model: string;
  hour: string;
  requests: number;
  tokens: Partial<Record<BillingDimension, number>>;
  cost: number;
}

interface UsageResponse {
  records: DisplayUsageRecord[];
  keys: Array<{ id: string; name: string; createdAt?: string }>;
}

interface SearchUsageRecord { provider: string; keyId: string; keyName?: string; keyCreatedAt?: string; hour: string; requests: number }

interface SearchUsageResponse {
  records: SearchUsageRecord[];
  keys: Array<{ id: string; name: string; createdAt?: string }>;
  activeProvider: string;
}

interface UsageByUserResponse {
  records: Array<{
    userId: number;
    model: string;
    hour: string;
    requests: number;
    tokens: Partial<Record<BillingDimension, number>>;
    cost: number;
  }>;
  users: Array<{ id: number; username: string }>;
}

interface SearchUsageByUserResponse {
  records: Array<{ provider: string; userId: number; hour: string; requests: number }>;
  users: Array<{ id: number; username: string }>;
  activeProvider: string;
}

type UsageView = 'all-by-user' | 'self-by-key';

const userBucketId = (userId: number): string => `user-${userId}`;

const fetchUsageForView = async (
  api: ApiClient,
  view: UsageView,
  start: string,
  end: string,
): Promise<{ usage: UsageResponse | null; search: SearchUsageResponse | null }> => {
  if (view === 'all-by-user') {
    const [usageRes, searchRes] = await Promise.all([
      callApi<UsageByUserResponse>(() => api.api['token-usage'].$get({ query: { start, end, include_user_metadata: '1', view: 'all-by-user' } })),
      callApi<SearchUsageByUserResponse>(() => api.api['search-usage'].$get({ query: { start, end, include_user_metadata: '1', view: 'all-by-user' } })),
    ]);
    return {
      usage: usageRes.data
        ? { records: usageRes.data.records.map(r => ({ keyId: userBucketId(r.userId), model: r.model, hour: r.hour, requests: r.requests, tokens: r.tokens, cost: r.cost })), keys: usageRes.data.users.map(u => ({ id: userBucketId(u.id), name: u.username })) }
        : null,
      search: searchRes.data
        ? { records: searchRes.data.records.map(r => ({ provider: r.provider, keyId: userBucketId(r.userId), hour: r.hour, requests: r.requests })), keys: searchRes.data.users.map(u => ({ id: userBucketId(u.id), name: u.username })), activeProvider: searchRes.data.activeProvider }
        : null,
    };
  }
  const [usageRes, searchRes] = await Promise.all([
    callApi<UsageResponse>(() => api.api['token-usage'].$get({ query: { start, end, include_key_metadata: '1', view: 'self-by-key' } })),
    callApi<SearchUsageResponse>(() => api.api['search-usage'].$get({ query: { start, end, include_key_metadata: '1', view: 'self-by-key' } })),
  ]);
  return { usage: usageRes.data ?? null, search: searchRes.data ?? null };
};

export const useUsagePageData = defineBasicLoader(async () => {
  const api = useApi();
  const auth = useAuthStore();
  const view: UsageView = auth.canViewGlobalTelemetry ? 'all-by-user' : 'self-by-key';
  const { start, end } = dashboardRangeQuery('today', Date.now());
  const [{ usage, search }] = await Promise.all([
    fetchUsageForView(api, view, start, end),
    useModelsStore().load(),
  ]);
  return {
    view,
    usage: usage ?? { records: [], keys: [] },
    search: search ?? { records: [], keys: [], activeProvider: 'disabled' },
  };
});
</script>

<script setup lang="ts">
type Metric =
  | 'requests' | 'cost'
  | 'total' | 'input' | 'output' | 'prefill'
  | 'cached' | 'cachedRate'
  | 'cacheCreation' | 'cacheHitRate';
type Range = DashboardRange;

const dim = (r: DisplayUsageRecord, k: BillingDimension): number => r.tokens[k] ?? 0;

const api = useApi();
const auth = useAuthStore();
const initialUsageData = useUsagePageData();
const modelsStore = useModelsStore();

const tokenRange = ref<Range>('today');
const loadedTokenRange = ref<Range>('today');
// Buckets and the request window are derived from the same `loadedAt` so the
// chart axis stays in lockstep with whichever data snapshot is currently shown.
const loadedAt = ref(Date.now());
const tokenChartMetric = ref<Metric>('total');
const redactKeys = ref(false);
const view = ref<UsageView>(initialUsageData.data.value.view);
const data = ref<UsageResponse | null>(initialUsageData.data.value.usage);
const searchData = ref<SearchUsageResponse | null>(initialUsageData.data.value.search);
const tokenLoading = ref(false);
const searchUsageLoading = ref(false);
let usageRequestId = 0;

// The three usage views interlock through a shared notion of "hidden" keys and
// models. Toggling a key in the By-Key (or Search) legend cross-filters the
// By-Model chart and the summary stats by that key; toggling a model in the
// By-Model legend cross-filters the By-Key chart and the stats. Each set drives
// both the chart it belongs to (own datasets struck out) and the value
// aggregation of the other dimension.
const hiddenKeys = ref(new Set<string>());
const hiddenModels = ref(new Set<string>());

const load = async () => {
  const requestId = ++usageRequestId;
  const requestedRange = tokenRange.value;
  const requestedView = view.value;
  const requestedAt = Date.now();
  tokenLoading.value = true;
  searchUsageLoading.value = true;
  const { start, end } = dashboardRangeQuery(requestedRange, requestedAt);
  try {
    const { usage, search } = await fetchUsageForView(api, requestedView, start, end);
    if (requestId !== usageRequestId || tokenRange.value !== requestedRange || view.value !== requestedView) return;
    if (usage) data.value = usage;
    if (search) searchData.value = search;
    loadedTokenRange.value = requestedRange;
    loadedAt.value = requestedAt;
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
watch(view, load);
useIntervalFn(() => { void load(); }, 60_000);

const tokenSummary = computed(() => {
  const records = (data.value?.records ?? []).filter(r => !hiddenKeys.value.has(r.keyId) && !hiddenModels.value.has(r.model));
  let requests = 0, cost = 0, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, inputImage = 0, outputImage = 0;
  for (const r of records) {
    requests += r.requests;
    cost += r.cost;
    input += dim(r, 'input');
    output += dim(r, 'output');
    cacheRead += dim(r, 'input_cache_read');
    cacheCreation += dim(r, 'input_cache_write') + dim(r, 'input_cache_write_1h');
    inputImage += dim(r, 'input_image');
    outputImage += dim(r, 'output_image');
  }
  return {
    requests, cost, cacheRead, cacheCreation,
    // Input and Output mix text and image token counts into one figure. The
    // per-modality split only affects pricing (applied per dimension already),
    // so we avoid extra image-only columns. Input is the inclusive prompt total
    // (text + image, uncached + cache read + cache write); prefill is that total
    // minus cache reads; output is text + image output.
    input: input + cacheRead + cacheCreation + inputImage,
    output: output + outputImage,
    total: input + output + cacheRead + cacheCreation + inputImage + outputImage,
    prefill: input + cacheCreation + inputImage,
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

const buckets = computed(() => dashboardBuckets(loadedTokenRange.value, loadedAt.value));

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
  case 'total': return dim(r, 'input') + dim(r, 'output') + dim(r, 'input_cache_read') + dim(r, 'input_cache_write') + dim(r, 'input_cache_write_1h') + dim(r, 'input_image') + dim(r, 'output_image');
  case 'input': return dim(r, 'input') + dim(r, 'input_cache_read') + dim(r, 'input_cache_write') + dim(r, 'input_cache_write_1h') + dim(r, 'input_image');
  case 'output': return dim(r, 'output') + dim(r, 'output_image');
  case 'prefill': return dim(r, 'input') + dim(r, 'input_cache_write') + dim(r, 'input_cache_write_1h') + dim(r, 'input_image');
  case 'cached': return dim(r, 'input_cache_read');
  case 'cacheCreation': return dim(r, 'input_cache_write') + dim(r, 'input_cache_write_1h');
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
  inputImage: number;
  outputImage: number;
  cost: number;
}

interface ChartEntry {
  id: string;
  label: string;
  colorSlot: number;
}

const keySeriesIsolation = createSeriesIsolation();
const modelSeriesIsolation = createSeriesIsolation();
const searchSeriesIsolation = createSeriesIsolation();

const keyChartEntries = (
  presentKeyIds: readonly string[],
  keyMetaMap: Map<string, KeyMeta>,
  keyIdsForOrder: readonly string[],
): ChartEntry[] => {
  // Color slot = the entity's index in the server-sorted metadata. The server
  // sorts by stable id (numeric for users, uuid lex for keys) so colors don't
  // shift on rename; new entities slot in by id. Records whose id is missing
  // from the metadata (deleted-with-no-row left a synthetic bucket) get
  // appended after the known entries by id.
  const slotById = new Map<string, number>(keyIdsForOrder.map((id, i) => [id, i]));
  const orphanIds = [...new Set(presentKeyIds)].filter(id => !slotById.has(id)).sort();
  orphanIds.forEach((id, i) => slotById.set(id, keyIdsForOrder.length + i));
  return [...new Set(presentKeyIds)]
    .map(id => ({
      id,
      label: redactKeyLabel(keyMetaMap.get(id)?.name ?? id.slice(0, 8), id),
      colorSlot: slotById.get(id)!,
    }))
    .sort((a, b) => a.colorSlot - b.colorSlot);
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
  if (metric === 'cachedRate') {
    const prompt = detail.input + detail.cacheRead + detail.cacheCreation + detail.inputImage;
    return prompt > 0 ? (detail.cacheRead / prompt) * 100 : null;
  }
  return null;
};

const emptyDetail = (): TokenDetail => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, inputImage: 0, outputImage: 0, cost: 0 });

const aggregateTokenRecords = (records: readonly DisplayUsageRecord[], groupKey: 'keyId' | 'model', metric: Metric) => {
  const { keys: bucketKeys, labels } = buckets.value;
  const values = new Map<string, Map<string, number | null>>();
  const details = new Map<string, Map<string, TokenDetail>>();
  for (const key of bucketKeys) {
    values.set(key, new Map());
    details.set(key, new Map());
  }
  for (const r of records) {
    const bucket = bucketKeyForUtcHour(loadedTokenRange.value, r.hour);
    if (!values.has(bucket)) continue;
    const group = r[groupKey];
    const bucketDetails = details.get(bucket)!;
    const detail = bucketDetails.get(group) ?? emptyDetail();
    detail.requests += r.requests;
    detail.input += dim(r, 'input');
    detail.output += dim(r, 'output');
    detail.cacheRead += dim(r, 'input_cache_read');
    detail.cacheCreation += dim(r, 'input_cache_write') + dim(r, 'input_cache_write_1h');
    detail.inputImage += dim(r, 'input_image');
    detail.outputImage += dim(r, 'output_image');
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
  return { bucketKeys, labels, values, details };
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
  const prompt = detail.input + detail.cacheRead + detail.cacheCreation + detail.inputImage;
  const output = detail.output + detail.outputImage;
  const total = prompt + output;
  const prefill = detail.input + detail.cacheCreation + detail.inputImage;
  return `${label.padEnd(labelWidth + 1)}${String(detail.requests).padStart(5)}  ${formatCost(detail.cost).padStart(9)}  ${formatTokenCount(total).padStart(7)}  ${formatTokenCount(cached).padStart(7)}  ${formatInputRate(cached, prompt).padStart(8)}  ${formatTokenCount(prefill).padStart(7)}  ${formatTokenCount(output).padStart(7)}  ${formatHitRate(detail.cacheRead, detail.cacheCreation).padStart(7)}`;
};

const keyMetadataForTokenRecords = (records: readonly DisplayUsageRecord[], metadata: readonly { id: string; name: string; createdAt?: string }[]) => {
  const map = new Map<string, KeyMeta>();
  for (const key of metadata) map.set(key.id, { name: key.name, createdAt: key.createdAt });
  for (const record of records) {
    const prev = map.get(record.keyId);
    map.set(record.keyId, { name: record.keyName ?? prev?.name, createdAt: record.keyCreatedAt ?? prev?.createdAt });
  }
  return map;
};

const buildStackedConfig = (groupKey: 'keyId' | 'model'): ChartConfiguration<'line'> => {
  const allRecords = data.value?.records ?? [];
  const metric = tokenChartMetric.value;
  const isPercent = isPercentMetric(metric);
  // Own legend toggles this dimension; the other dimension's hidden set
  // cross-filters which records contribute to this chart's values.
  const ownHidden = groupKey === 'keyId' ? hiddenKeys : hiddenModels;
  const otherDimension: 'keyId' | 'model' = groupKey === 'keyId' ? 'model' : 'keyId';
  const otherHidden = groupKey === 'keyId' ? hiddenModels : hiddenKeys;
  const valueRecords = allRecords.filter(r => !otherHidden.value.has(r[otherDimension]));
  const { bucketKeys, labels, values, details } = aggregateTokenRecords(valueRecords, groupKey, metric);
  // Color slots are assigned from the full dataset so each group keeps a stable
  // color no matter how cross-filtering changes which groups remain.
  const presentGroups = new Set(allRecords.map(r => r[groupKey]));
  const entries = groupKey === 'keyId'
    ? keyChartEntries([...presentGroups], keyMetadataForTokenRecords(allRecords, data.value?.keys ?? []), data.value?.keys.map(k => k.id) ?? [...presentGroups])
    : modelChartEntries([...presentGroups]);
  // A group can hold all-zero (or, for percent metrics, all-null) values under
  // the current metric for two distinct reasons, and requests tells them apart:
  // cross-filtering that emptied the group leaves requests at zero too (details
  // aggregate the same cross-filtered records), whereas a group with real but
  // zero-token traffic — e.g. an upstream that reports no usage — still has
  // requests > 0. Keep the latter as a flat line at zero so it stays visible in
  // the token/cost views; drop the former outright, legend entry and line both
  // gone, instead of rendering an inert line for a group with no activity. Own-
  // dimension hidden groups are a separate, restorable toggle kept struck-through.
  // Percent metrics stay null-only: a ratio over zero tokens is undefined.
  //
  // Non-percent buckets fall back to `0` (not `null`) so every dataset carries
  // a numeric value at every index — stacked line rendering then accumulates
  // correctly and every series draws a continuous line all the way across the
  // axis, edges included. `spanGaps` only stitches internal gaps, so leaving
  // nulls in would leave the leading and trailing "no record" buckets unlit.
  // The tooltip filter reaches back into `details.requests` to distinguish a
  // synthesized 0 from a real zero-token record.
  const hasRequests = (id: string) => bucketKeys.some(k => (details.get(k)?.get(id)?.requests ?? 0) > 0);
  const datasetEntries = entries
    .map(entry => ({ entry, data: bucketKeys.map(k => values.get(k)!.get(entry.id) ?? (isPercent ? null : 0)) }))
    .filter(({ entry, data }) => isPercent ? data.some(v => v !== null) : (data.some(v => v !== 0) || hasRequests(entry.id)));
  const labelWidth = datasetEntries.reduce((max, { entry }) => Math.max(max, entry.label.length), 0);
  return {
    type: 'line',
    data: {
      labels,
      datasets: datasetEntries.map(({ entry, data: datasetData }) => {
        const color = chartColor(entry.colorSlot);
        // A dataset kept only because its group has real requests — every
        // selected-metric value is zero — would, when stacked onto the series
        // below it, ride invisibly along that series' top edge rather than sit
        // at zero. Give it a private stack group and drop the fill so it draws
        // as a flat, hoverable line pinned to the axis. It contributes nothing
        // to the main stack, so pulling it out leaves the real totals untouched.
        const zeroLine = !isPercent && !datasetData.some(v => v !== 0);
        return {
          label: entry.label,
          seriesId: entry.id,
          data: datasetData,
          hidden: ownHidden.value.has(entry.id),
          borderColor: color,
          backgroundColor: `${color}40`,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.3,
          fill: isPercent || zeroLine ? false : 'stack',
          spanGaps: isPercent,
          stack: zeroLine ? 'axis' : 'main',
          // Zero-line series draw at y=0 and get painted over by any main-stack
          // area whose bottom sits at the axis; render them last (lower `order`
          // = drawn on top) so their flat line and points stay visible.
          order: zeroLine ? -1 : 0,
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
          onClick: (event, legendItem) => {
            const entry = datasetEntries[legendItem.datasetIndex!].entry;
            const isolation = groupKey === 'keyId' ? keySeriesIsolation : modelSeriesIsolation;
            handleLegendClick(event, isolation, ownHidden.value, datasetEntries.map(({ entry }) => entry.id), entry.id);
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
          // Null y = no record in this bucket (dropped). A stacked-dataset zero
          // may be either a real zero-token record or a synthesized fill for a
          // no-record bucket — the latter must not appear in the tooltip, so
          // reach back into `details.requests` to keep only rows where the
          // group actually served requests.
          filter: item => {
            if (item.parsed.y === null) return false;
            if (isPercent || item.parsed.y > 0) return true;
            const bucket = bucketKeys[item.dataIndex];
            const entry = datasetEntries[item.datasetIndex]?.entry;
            return bucket !== undefined && entry !== undefined
              && (details.get(bucket)?.get(entry.id)?.requests ?? 0) > 0;
          },
          itemSort: (a, b) => Number(b.parsed.y ?? 0) - Number(a.parsed.y ?? 0),
          callbacks: {
            beforeBody: items => items.length ? tooltipHeader(labelWidth) : [],
            label: (ctx: TooltipItem<'line'>) => {
              const bucket = bucketKeys[ctx.dataIndex];
              const entry = datasetEntries[ctx.datasetIndex]?.entry;
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
const byKeySeriesIds = computed(() => chartSeriesIds(byKeyConfig.value));
const byModelSeriesIds = computed(() => chartSeriesIds(byModelConfig.value));

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
  const entries = keyChartEntries([...presentGroups], meta, searchData.value?.keys.map(k => k.id) ?? [...presentGroups]);
  return {
    type: 'line',
    data: {
      labels,
      datasets: entries.map(entry => {
        const color = chartColor(entry.colorSlot);
        return {
          label: entry.label,
          seriesId: entry.id,
          data: bucketKeys.map(k => groups.get(entry.id)?.get(k) ?? 0),
          hidden: hiddenKeys.value.has(entry.id),
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
        legend: {
          position: 'bottom',
          labels: { color: '#9e9e9e', font: { size: 11, family: chartFont.sans }, boxWidth: 12, padding: 16, usePointStyle: true, pointStyle: 'circle' },
          onClick: (event, legendItem) => {
            const entry = entries[legendItem.datasetIndex!];
            handleLegendClick(event, searchSeriesIsolation, hiddenKeys.value, entries.map(entry => entry.id), entry.id);
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

const searchByKeySeriesIds = computed(() => chartSeriesIds(searchByKeyConfig.value));

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
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Token Usage</span>
          <div v-if="auth.canViewGlobalTelemetry" class="inline-flex rounded-md bg-surface-800 p-0.5" role="tablist">
            <button
              type="button"
              class="px-2 py-1 text-[11px] font-medium rounded transition-colors"
              :class="view === 'all-by-user' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="view = 'all-by-user'"
            >All by user</button>
            <button
              type="button"
              class="px-2 py-1 text-[11px] font-medium rounded transition-colors"
              :class="view === 'self-by-key' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              @click="view = 'self-by-key'"
            >My keys</button>
          </div>
          <button
            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md p-1 transition-colors text-gray-600 hover:text-gray-400 hover:bg-white/[0.04]"
            :aria-label="view === 'all-by-user' ? 'Toggle user name redaction' : 'Toggle key name redaction'"
            :title="view === 'all-by-user' ? 'Redact usernames' : 'Redact key names'"
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

      <div class="mb-2 flex justify-end">
        <ChartSeriesControls label="Token usage series selection" @select="applySeriesSelection(hiddenKeys, byKeySeriesIds, $event)" />
      </div>
      <div style="height: 320px; position: relative;">
        <ChartCanvas :config="byKeyConfig" />
      </div>

      <div class="mt-6 pt-5 border-t border-white/5">
        <div class="flex items-center justify-between gap-3 mb-4">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest block">By Model</span>
          <ChartSeriesControls label="Model usage series selection" @select="applySeriesSelection(hiddenModels, byModelSeriesIds, $event)" />
        </div>
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
        <div class="flex items-center justify-between gap-3 mb-4">
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest block">Search Usage</span>
            <Spinner v-if="searchUsageLoading" class="h-3.5 w-3.5 text-gray-500" />
          </div>
          <ChartSeriesControls label="Search usage series selection" @select="applySeriesSelection(hiddenKeys, searchByKeySeriesIds, $event)" />
        </div>
        <div style="height: 320px; position: relative;">
          <ChartCanvas :config="searchByKeyConfig" />
        </div>
      </div>
    </div>
  </div>
</template>
