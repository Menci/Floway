import { LineChart, type ChartProps, type CustomizedCalloutData } from '@fluentui/react-charts';
import { ArrowClockwiseRegular, InfoRegular } from '@fluentui/react-icons';
import { curveMonotoneX } from 'd3-shape';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect, useSearchParams, type ShouldRevalidateFunctionArgs } from 'react-router';

import type { Route } from './+types/dashboard-monitor-performance';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import { getSessionToken } from '../auth/session';
import { ChartSection } from '../components/charts/chart-section';
import { colorForSlot } from '../components/charts/palette';
import {
  buildPerformanceQuery,
  clearGroupedFilter,
  emptyPerformanceOverview,
  performanceValue,
  parsePerformanceUrlState,
  resolvePerformanceGroup,
  serializePerformanceUrlState,
  type PerformanceDisplayRecord,
  type PerformanceFilters,
  type PerformanceGroupBy,
  type PerformanceMetric,
  type PerformanceOverviewResponse,
  type PerformancePercentile,
  type PerformanceRange,
  type PerformanceView,
} from '../components/performance/performance-data';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Select } from '../components/ui/fluent-form-controls';
import { OutlineCard } from '../components/ui/outline-card';
import { Panel } from '../components/ui/panel';
import { ScrollArea } from '../components/ui/scroll-area';
import { SegmentedControl } from '../components/ui/segmented-control';
import { fluentComponents } from '../fluent';
import { localeForLanguage } from '../i18n';
import { useAuthStore } from '../stores/auth-store';

const {
  Button, makeStyles, MessageBar, MessageBarBody,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip,
} = fluentComponents;

interface Bucket { key: string; label: string; date: Date }
interface ChartEntry { id: string; label: string; colorSlot: number }
interface PerformanceChartModel { data: ChartProps; entries: ChartEntry[]; buckets: Bucket[]; range: PerformanceRange; metric: PerformanceMetric }
interface UpstreamName { id: string; name: string }

const chartMargins = { top: 16, right: 20, bottom: 42, left: 64 } as const;
const groupByValues: PerformanceGroupBy[] = ['model', 'upstream', 'operation', 'runtimeLocation', 'keyId', 'userId'];

const useChartStateStyles = makeStyles({
  root: { alignItems: 'center', color: 'var(--colorNeutralForeground3)', display: 'grid', fontSize: '13px', height: '100%', justifyItems: 'center' },
});
const usePerformanceChartStyles = makeStyles({
  root: { '& .fui-cart__xAxis line': { pointerEvents: 'none' }, '& circle[id*="staticHighlightCircle"]': { pointerEvents: 'none', visibility: 'hidden' } },
});

interface LoaderData {
  error: string | null;
  loadedAt: number;
  overview: PerformanceOverviewResponse;
  state: ReturnType<typeof parsePerformanceUrlState>;
  upstreamNames: UpstreamName[];
  view: PerformanceView;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const user = await useAuthStore.getState().initialize();
  if (!user) throw redirect('/');
  const state = parsePerformanceUrlState(new URL(request.url).searchParams);
  const view: PerformanceView = user.isAdmin ? 'all-by-user' : 'self-by-key';
  const groupBy = state.groupBy === 'userId' && view !== 'all-by-user' ? 'model' : state.groupBy;
  const loadedAt = Date.now();
  const query = buildPerformanceQuery(view, state.range, groupBy, state.filters, loadedAt);
  const [overview, upstreams] = await Promise.all([
    callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({ query: Object.fromEntries(query) })),
    callApi<UpstreamName[]>(() => api.api.upstreams.$get()),
  ]);
  return {
    error: overview.error?.message ?? upstreams.error?.message ?? null,
    loadedAt,
    overview: overview.data ?? emptyPerformanceOverview(),
    state: { ...state, groupBy },
    upstreamNames: upstreams.data ?? [],
    view,
  };
}

export const shouldRevalidate = ({ currentUrl, defaultShouldRevalidate, nextUrl }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname === nextUrl.pathname ? false : defaultShouldRevalidate;

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Performance | Floway' }];
}

export default function DashboardMonitorPerformance({ loaderData }: Route.ComponentProps) {
  const { i18n, t } = useTranslation();
  const clearAuth = useAuthStore(state => state.clear);
  const [, setSearchParams] = useSearchParams();
  const initialState = loaderData.state;
  const view: PerformanceView = loaderData.view;
  const [range, setRange] = useState<PerformanceRange>(initialState.range);
  const [loadedRange, setLoadedRange] = useState<PerformanceRange>(initialState.range);
  const [loadedAt, setLoadedAt] = useState(loaderData.loadedAt);
  const [metric, setMetric] = useState<PerformanceMetric>(initialState.metric);
  const [percentile, setPercentile] = useState<PerformancePercentile>(initialState.percentile);
  const [groupBy, setGroupBy] = useState<PerformanceGroupBy>(initialState.groupBy === 'userId' && view !== 'all-by-user' ? 'model' : initialState.groupBy);
  const [filters, setFilters] = useState<PerformanceFilters>(initialState.filters);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(initialState.hidden));
  const [overview, setOverview] = useState<PerformanceOverviewResponse>(loaderData.overview);
  const [upstreamNames] = useState(() => new Map(loaderData.upstreamNames.map(item => [item.id, item.name])));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(loaderData.error);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const locale = localeForLanguage(i18n.language);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const requestedAt = Date.now();
    setLoading(true);
    setError(null);
    const search = buildPerformanceQuery(view, range, groupBy, filters, requestedAt);
    const result = await callApi<PerformanceOverviewResponse>(() => api.api.performance.overview.$get({ query: Object.fromEntries(search) }));
    if (requestId !== requestIdRef.current) return;
    if (result.error) setError(result.error.message);
    else {
      setOverview(result.data);
      setLoadedRange(range);
      setLoadedAt(requestedAt);
    }
    setLoading(false);
  }, [filters, groupBy, range, view]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    void refresh();
    return () => { requestIdRef.current += 1; };
  }, [refresh]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);

  useEffect(() => { if (error === 'HTTP 401') clearAuth(); }, [clearAuth, error]);

  useEffect(() => {
    setSearchParams(serializePerformanceUrlState({ metric, percentile, groupBy, range, filters, hidden: [...hiddenSeries] }), { replace: true });
  }, [filters, groupBy, hiddenSeries, metric, percentile, range, setSearchParams]);

  const changeGroupBy = (next: PerformanceGroupBy) => {
    setGroupBy(next);
    setFilters(current => clearGroupedFilter(current, next));
    setHiddenSeries(new Set());
  };
  const setFilter = (key: keyof PerformanceFilters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  const buckets = useMemo(() => dashboardBuckets(loadedRange, loadedAt, locale), [loadedAt, loadedRange, locale]);
  const chart = useMemo(() => buildPerformanceChart(overview.series, metric, percentile, groupBy, overview, upstreamNames, buckets, loadedRange), [buckets, groupBy, loadedRange, metric, overview, percentile, upstreamNames]);
  const summary = overview.axes.none[0];
  const summaryCards = [
    ['requests', formatCount(summary?.requests ?? 0, locale)],
    ['errors', formatCount(summary?.errors ?? 0, locale)],
    ['ttftP50', formatDuration(summary?.ttftMsP50 ?? null)],
    ['speedP50', formatTokensPerSecond(summary?.tpotUsP50 ?? null)],
    ['ttftP95', formatDuration(summary?.ttftMsP95 ?? null)],
    ['speedP95', formatTokensPerSecond(summary?.tpotUsP95 ?? null)],
    ['ttftP99', formatDuration(summary?.ttftMsP99 ?? null)],
    ['speedP99', formatTokensPerSecond(summary?.tpotUsP99 ?? null)],
  ] as const;
  const breakdowns = groupByValues
    .filter(key => key !== 'userId' || view === 'all-by-user')
    .map(key => ({ key, rows: overview.axes[key] }));

  return <section className="grid gap-[18px] min-w-0">
    <DashboardPageHeader
      actions={<>
        <Tooltip content={t('dashboard.performance.actions.refresh')} relationship="label"><Button appearance="subtle" disabled={loading} icon={<ArrowClockwiseRegular />} onClick={() => void refresh()} /></Tooltip>
      </>}
      description={t('dashboard.pages.performance')}
      eyebrow={t('dashboard.groups.monitor')}
      title={t('dashboard.nav.performance')}
    />
    {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    <Panel className="!grid gap-[16px] min-w-0 !p-[18px]">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <SegmentedControl ariaLabel={t('dashboard.performance.metric.label')} items={[
          { value: 'ttft', label: t('dashboard.performance.metric.ttft') },
          { value: 'tokPerSec', label: t('dashboard.performance.metric.outputSpeed') },
        ]} onChange={value => setMetric(value as PerformanceMetric)} value={metric} />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl ariaLabel={t('dashboard.performance.percentile.label')} items={(['p50', 'p95', 'p99'] as const).map(value => ({ value, label: value }))} onChange={value => setPercentile(value as PerformancePercentile)} value={percentile} />
          <SegmentedControl ariaLabel={t('dashboard.performance.range.label')} items={[
            { value: 'today', label: t('dashboard.performance.range.today') }, { value: '7d', label: t('dashboard.performance.range.sevenDays') }, { value: '30d', label: t('dashboard.performance.range.thirtyDays') },
          ]} onChange={value => setRange(value as PerformanceRange)} value={range} />
        </div>
      </div>
      <div className="flex items-start gap-6 justify-between min-w-0 max-[900px]:flex-col max-[900px]:gap-4">
        <div className="flex items-center gap-2 flex-none">
          <Text weight="semibold">{t('dashboard.performance.groupBy.label')}</Text>
          <Select aria-label={t('dashboard.performance.groupBy.label')} className="min-w-[160px]" value={groupBy} onChange={(_, data) => changeGroupBy(data.value as PerformanceGroupBy)}>
            {groupByValues.filter(value => value !== 'userId' || view === 'all-by-user').map(value => <option key={value} value={value}>{t(`dashboard.performance.groupBy.${value}`)}</option>)}
          </Select>
          {groupBy === 'keyId' && (
            <Tooltip content={t('dashboard.performance.apiKeyScopeInfo')} relationship="description">
              <Button
                appearance="subtle"
                aria-label={t('dashboard.performance.apiKeyScopeLabel')}
                className="!min-w-[36px] !text-fui-base500"
                icon={<InfoRegular fontSize={22} />}
                size="large"
              />
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-2 justify-end min-w-0 max-[900px]:w-full max-[900px]:justify-start">
          <Text className="flex-none" weight="semibold">{t('dashboard.performance.filters.label')}</Text>
          <PerformanceFiltersBar filters={filters} groupBy={groupBy} overview={overview} upstreamNames={upstreamNames} view={view} onChange={setFilter} />
        </div>
      </div>
      <div className="grid gap-2.5 grid-cols-8 max-[1150px]:grid-cols-4 max-[620px]:grid-cols-2">
        {summaryCards.map(([label, value]) => <OutlineCard className="!p-[10px] min-w-0" key={label}>
          <Text size={200} weight="semibold" className="text-fui-fg2 leading-[1.2]">{t(`dashboard.performance.summary.${label}`)}</Text>
          <Text size={500} weight="semibold" className="font-mono overflow-wrap-anywhere">{value}</Text>
        </OutlineCard>)}
      </div>
    </Panel>
    <Panel className="!grid gap-[18px] min-w-0 !p-[18px]">
      <PerformanceChartSection chart={chart} hidden={hiddenSeries} onHiddenChange={setHiddenSeries} title={t('dashboard.performance.chartTitle', { metric: t(`dashboard.performance.metric.${metric === 'ttft' ? 'ttft' : 'outputSpeed'}`), group: t(`dashboard.performance.groupBy.${groupBy}`), percentile })} />
    </Panel>
    <div className="grid grid-cols-2 gap-[18px] min-w-0 max-[920px]:grid-cols-1">
      {breakdowns.map(({ key, rows }) => (
        <Panel className="!p-[18px] min-w-0" key={key}>
          <PerformanceTable groupBy={key} overview={overview} rows={rows} upstreamNames={upstreamNames} />
        </Panel>
      ))}
    </div>
  </section>;
}

function PerformanceFiltersBar({ filters, groupBy, onChange, overview, upstreamNames, view }: {
  filters: PerformanceFilters; groupBy: PerformanceGroupBy; onChange: (key: keyof PerformanceFilters, value: string) => void;
  overview: PerformanceOverviewResponse; upstreamNames: ReadonlyMap<string, string>; view: PerformanceView;
}) {
  const { t } = useTranslation();
  const entries: Array<{ key: keyof PerformanceFilters; values: Array<{ value: string; label: string }> }> = [
    { key: 'model', values: overview.dimensionValues.models.map(value => ({ value, label: value })) },
    { key: 'upstream', values: overview.dimensionValues.upstreams.map(value => ({ value, label: upstreamNames.get(value) ?? value })) },
    { key: 'operation', values: overview.dimensionValues.operations.map(value => ({ value, label: value })) },
    { key: 'runtimeLocation', values: overview.dimensionValues.runtimeLocations.map(value => ({ value, label: value })) },
    { key: 'userId', values: overview.dimensionValues.userIds.map(value => ({ value: String(value), label: overview.users.find(user => user.id === value)?.username ?? `user ${value}` })) },
    { key: 'keyId', values: overview.dimensionValues.keyIds.map(value => ({ value, label: overview.keys.find(key => key.id === value)?.name ?? value })) },
  ];
  return <div className="flex flex-wrap items-center gap-2 justify-end min-w-0 max-[900px]:justify-start">
    {entries.filter(({ key }) => {
      if (key === 'userId' && view !== 'all-by-user') return false;
      if ((key === 'userId' || key === 'keyId') && (groupBy === 'userId' || groupBy === 'keyId')) return false;
      return key !== groupBy;
    }).map(({ key, values }) => <div className="min-w-[130px] max-w-[220px]" key={key}>
      <Select aria-label={t(`dashboard.performance.filters.${key}`)} value={filters[key]} onChange={(_, data) => onChange(key, data.value)}>
        <option value="">{t(`dashboard.performance.filters.all.${key}`)}</option>
        {values.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </Select>
    </div>)}
  </div>;
}

function PerformanceChartSection({ chart, hidden, onHiddenChange, title }: { chart: PerformanceChartModel; hidden: Set<string>; onHiddenChange: (next: Set<string>) => void; title: string }) {
  const { t } = useTranslation();
  return <ChartSection controlsLabel={t('dashboard.performance.series.label')} emptyText={t('dashboard.performance.empty')} entries={chart.entries} hidden={hidden} onHiddenChange={onHiddenChange} title={title}>
    <PerformanceChart chart={chart} hidden={hidden} />
  </ChartSection>;
}

function PerformanceChart({ chart, hidden }: { chart: PerformanceChartModel; hidden: Set<string> }) {
  const { i18n, t } = useTranslation();
  const stateStyles = useChartStateStyles();
  const chartStyles = usePerformanceChartStyles();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(host);
  const locale = localeForLanguage(i18n.language);
  const formatter = chart.metric === 'ttft' ? formatDuration : formatRate;
  const visibleLegends = chart.entries.filter(entry => !hidden.has(entry.id)).map(entry => entry.label);
  const visibleData = useMemo<ChartProps>(() => ({ ...chart.data, lineChartData: chart.data.lineChartData?.filter(series => visibleLegends.includes(series.legend)) }), [chart.data, visibleLegends]);
  const values = visibleData.lineChartData?.flatMap(series => series.data.map(point => point.y).filter((value): value is number => typeof value === 'number' && value > 0)) ?? [];
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const callout = useCallback((props?: CustomizedCalloutData): ReactElement | null => !props?.values.length ? null : <div className="grid gap-[6px] min-w-[220px] p-1"><Text size={200} weight="semibold">{formatCalloutTitle(props.x, labelByTime, chart.range, locale)}</Text>{props.values.filter(item => item.y > 0).sort((a, b) => b.y - a.y).map(item => <Text key={item.legend} size={200} className="flex gap-3 justify-between font-mono"><span>{item.legend}</span><span>{formatter(item.y)}</span></Text>)}</div>, [chart.range, formatter, labelByTime, locale]);
  const plotHeight = Math.max(0, size.height - chartMargins.top - chartMargins.bottom);
  return <div className={`${chartStyles.root} h-[320px] min-w-0 w-full`} ref={setHost}>{size.width < 120 ? null : visibleData.lineChartData?.length ? <LineChart customDateTimeFormatter={date => formatAxisDate(date, chart.range, locale)} data={visibleData} height={size.height} hideLegend margins={chartMargins} onRenderCalloutPerStack={callout} tickValues={chartTickValues(chart.buckets).map(bucket => bucket.date)} width={size.width} xAxistickSize={-plotHeight} yAxisTickFormat={formatter} yMaxValue={values.length ? Math.max(...values) : undefined} yMinValue={values.length ? Math.min(...values) : undefined} yScaleType="log" /> : <div className={stateStyles.root}>{t('dashboard.performance.empty')}</div>}</div>;
}

function PerformanceTable({ groupBy, overview, rows, upstreamNames }: { groupBy: PerformanceGroupBy; overview: PerformanceOverviewResponse; rows: PerformanceDisplayRecord[]; upstreamNames: ReadonlyMap<string, string> }) {
  const { i18n, t } = useTranslation();
  const locale = localeForLanguage(i18n.language);
  return <section className="grid gap-2.5 min-w-0">
    <Text size={300} weight="semibold">{t(`dashboard.performance.groupBy.${groupBy}`)}</Text>
    <ScrollArea axes="horizontal" className="border border-fui-stroke1 rounded-lg min-w-0"><Table aria-label={t(`dashboard.performance.groupBy.${groupBy}`)} size="small" className="min-w-[570px]">
      <TableHeader><TableRow><TableHeaderCell>{t(`dashboard.performance.filters.${groupBy}`)}</TableHeaderCell><TableHeaderCell className="!text-right">{t('dashboard.performance.tables.requests')}</TableHeaderCell><TableHeaderCell className="!text-right">{t('dashboard.performance.tables.errors')}</TableHeaderCell><TableHeaderCell className="!text-right">{t('dashboard.performance.tables.ttftP95')}</TableHeaderCell><TableHeaderCell className="!text-right">{t('dashboard.performance.tables.speedP95')}</TableHeaderCell></TableRow></TableHeader>
      <TableBody>{rows.length ? [...rows].sort((a, b) => b.requests - a.requests).map(row => <TableRow key={row.group}><TableCell><span className="block max-w-[250px] overflow-hidden text-ellipsis whitespace-nowrap" title={row.group}>{resolvePerformanceGroup(row.group, groupBy, overview, upstreamNames)}</span></TableCell><TableCell className="!text-right font-mono">{formatCount(row.requests, locale)}</TableCell><TableCell className="!text-right font-mono">{formatCount(row.errors, locale)}</TableCell><TableCell className="!text-right font-mono">{formatDuration(row.ttftMsP95)}</TableCell><TableCell className="!text-right font-mono">{formatTokensPerSecond(row.tpotUsP95)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5}><Text size={200} className="text-fui-fg2">{t('dashboard.performance.empty')}</Text></TableCell></TableRow>}</TableBody>
    </Table></ScrollArea>
  </section>;
}

function buildPerformanceChart(records: PerformanceDisplayRecord[], metric: PerformanceMetric, percentile: PerformancePercentile, groupBy: PerformanceGroupBy, overview: PerformanceOverviewResponse, upstreamNames: ReadonlyMap<string, string>, buckets: Bucket[], range: PerformanceRange): PerformanceChartModel {
  const groups = [...new Set(records.map(record => record.group))].sort();
  const entries = groups.map((group, colorSlot) => ({ id: group, label: resolvePerformanceGroup(group, groupBy, overview, upstreamNames), colorSlot }));
  const values = new Map(records.map(record => [`${record.bucket}\0${record.group}`, record]));
  return {
    entries, buckets, range, metric, data: {
      chartTitle: '', lineChartData: entries.flatMap(entry => {
        const data = buckets.flatMap(bucket => { const value = values.get(`${bucket.key}\0${entry.id}`); const y = value ? performanceValue(value, metric, percentile) : null; return y === null || y <= 0 ? [] : [{ x: bucket.date, y }]; });
        return data.length ? [{ legend: entry.label, color: colorForSlot(entry.colorSlot), lineOptions: { strokeWidth: 2, curve: curveMonotoneX }, data }] : [];
      }),
    },
  };
}

const pad2 = (value: number) => String(value).padStart(2, '0');
const localHourKey = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}`;
const localDateKey = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const local4hStart = (date: Date) => { const next = new Date(date); next.setMinutes(0, 0, 0); next.setHours(next.getHours() - next.getHours() % 4); return next; };
const dashboardBuckets = (range: PerformanceRange, now: number, locale: string): Bucket[] => {
  if (range === 'today') { const current = new Date(now); current.setMinutes(0, 0, 0); return Array.from({ length: 24 }, (_, i) => { const date = new Date(current.getTime() - (23 - i) * 3_600_000); return { key: localHourKey(date), date, label: date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) }; }); }
  if (range === '7d') { const current = local4hStart(new Date(now)); return Array.from({ length: 42 }, (_, i) => { const date = new Date(current.getTime() - (41 - i) * 4 * 3_600_000); return { key: localHourKey(date), date, label: date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit' }) }; }); }
  return Array.from({ length: 30 }, (_, i) => { const date = new Date(now); date.setDate(date.getDate() - (29 - i)); date.setHours(0, 0, 0, 0); return { key: localDateKey(date), date, label: date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) }; });
};
function useElementSize(element: HTMLElement | null) { const [size, setSize] = useState({ width: 0, height: 320 }); useLayoutEffect(() => { if (!element) return; const update = () => { const rect = element.getBoundingClientRect(); setSize({ width: Math.floor(rect.width), height: Math.max(260, Math.floor(rect.height)) }); }; update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect(); }, [element]); return size; }
const chartTickValues = (buckets: Bucket[]) => { if (buckets.length <= 8) return buckets; const step = Math.ceil((buckets.length - 1) / 6); const ticks = buckets.filter((_, index) => index % step === 0); const last = buckets.at(-1); if (last && ticks.at(-1) !== last) ticks.push(last); return ticks; };
const formatAxisDate = (date: Date, range: PerformanceRange, locale: string) => range === 'today' ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString(locale, { month: '2-digit', day: '2-digit', ...(range === '7d' ? { hour: '2-digit' } : {}) });
const formatCalloutTitle = (value: Date | number | string, labels: Map<number, string>, range: PerformanceRange, locale: string) => value instanceof Date ? labels.get(value.getTime()) ?? formatAxisDate(value, range, locale) : typeof value === 'number' ? value.toLocaleString(locale) : value;
function formatDuration(ms: number | null) { if (ms === null || !Number.isFinite(ms)) return '-'; if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`; if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`; return `${Math.round(ms)}ms`; }
function formatRate(value: number | null) { if (value === null || !Number.isFinite(value) || value <= 0) return '-'; return value >= 100 ? `${Math.round(value)} tok/s` : value >= 10 ? `${value.toFixed(1)} tok/s` : `${value.toFixed(2)} tok/s`; }
const formatTokensPerSecond = (us: number | null) => us === null || us <= 0 ? '-' : formatRate(1_000_000 / us);
const formatCount = (value: number, locale: string) => Math.max(0, Math.round(value)).toLocaleString(locale);
