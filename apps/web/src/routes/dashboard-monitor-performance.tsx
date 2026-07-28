import { LineChart, type ChartProps, type CustomizedCalloutData } from '@fluentui/react-charts';
import { ArrowClockwiseRegular, InfoRegular } from '@fluentui/react-icons';
import { curveMonotoneX } from 'd3-shape';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect, useSearchParams, type ShouldRevalidateFunctionArgs } from 'react-router';

import type { Route } from './+types/dashboard-monitor-performance';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import { getSessionToken } from '../auth/session';
import { useUnclippedChartFrame } from '../components/charts/chart-frame-styles';
import { ChartSection } from '../components/charts/chart-section';
import { chartTickValues, dashboardBucketFrames, formatAxisDate, formatCalloutTitle } from '../components/charts/dashboard-time';
import { colorForSlot } from '../components/charts/palette';
import { useElementSize } from '../components/charts/use-element-size';
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
import { Panel } from '../components/ui/panel';
import { ScrollArea } from '../components/ui/scroll-area';
import { ChoiceGroup } from '../components/ui/choice-group';
import { fluentComponents } from '../fluent';
import { localeForLanguage } from '../i18n';
import { useAuthStore } from '../stores/auth-store';

const {
  Button, Field, Tab, TabList, makeStyles, MessageBar, MessageBarBody,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip,
} = fluentComponents;

interface Bucket { key: string; label: string; date: Date }
interface ChartEntry { id: string; label: string; colorSlot: number }
interface PerformanceChartModel { data: ChartProps; entries: ChartEntry[]; buckets: Bucket[]; range: PerformanceRange; metric: PerformanceMetric }
interface UpstreamName { id: string; name: string }

const chartMargins = { top: 16, right: 20, bottom: 42, left: 64 } as const;
// A log axis emits a tick per significant digit, so the sub-second decade alone
// printed 400ms/500ms/600ms/700ms/800ms/900ms/1.0s into the height of two
// labels — measured at 6px apart. `yAxisTickCount` is ignored on a log scale,
// so the ticks stay (they are the minor gridlines a log axis is read against)
// and only the labels thin out, to the 1/2/5 mantissas that are the convention
// for a labelled decade.
const LABELLED_LOG_MANTISSAS = [1, 2, 5];
const labelledOnLogAxis = (value: number): boolean => {
  if (!(value > 0)) return false;
  const mantissa = value / 10 ** Math.floor(Math.log10(value));
  return LABELLED_LOG_MANTISSAS.some(candidate => Math.abs(mantissa - candidate) < 0.01);
};
const groupByValues: PerformanceGroupBy[] = ['model', 'upstream', 'operation', 'runtimeLocation', 'keyId', 'userId'];

const useChartStateStyles = makeStyles({
  root: { alignItems: 'center', color: 'var(--colorNeutralForeground3)', display: 'grid', fontSize: '13px', height: '100%', justifyItems: 'center' },
});
const usePerformanceChartStyles = makeStyles({
  root: { '& .fui-cart__xAxis line': { pointerEvents: 'none' }, '& circle[id*="staticHighlightCircle"]': { pointerEvents: 'none', visibility: 'hidden' } },
});
const usePerformanceTableStyles = makeStyles({
  numericHeader: {
    whiteSpace: 'nowrap',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end', whiteSpace: 'nowrap' },
  },
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
    callApi(() => api.api.performance.overview.$get({ query: Object.fromEntries(query) })),
    callApi(() => api.api.upstreams.$get()),
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
  const [breakdownGroup, setBreakdownGroup] = useState<PerformanceGroupBy>('model');
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
    const result = await callApi(() => api.api.performance.overview.$get({ query: Object.fromEntries(search) }));
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
  const buckets = useMemo(() => performanceBuckets(loadedRange, loadedAt, locale), [loadedAt, loadedRange, locale]);
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
  const activeBreakdown = breakdowns.find(item => item.key === breakdownGroup) ?? breakdowns[0]!;

  return <section className="dashboard-page">
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
      <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] items-start gap-4">
        <Field label={t('dashboard.performance.metric.label')}><ChoiceGroup ariaLabel={t('dashboard.performance.metric.label')} items={[
          { value: 'ttft', label: t('dashboard.performance.metric.ttft') },
          { value: 'tokPerSec', label: t('dashboard.performance.metric.outputSpeed') },
        ]} onChange={value => setMetric(value as PerformanceMetric)} value={metric} /></Field>
        <Field label={t('dashboard.performance.percentile.label')}><ChoiceGroup ariaLabel={t('dashboard.performance.percentile.label')} items={(['p50', 'p95', 'p99'] as const).map(value => ({ value, label: value }))} onChange={value => setPercentile(value as PerformancePercentile)} value={percentile} /></Field>
        <Field label={t('dashboard.performance.range.label')}><ChoiceGroup ariaLabel={t('dashboard.performance.range.label')} items={[
            { value: 'today', label: t('dashboard.performance.range.today') }, { value: '7d', label: t('dashboard.performance.range.sevenDays') }, { value: '30d', label: t('dashboard.performance.range.thirtyDays') },
          ]} onChange={value => setRange(value as PerformanceRange)} value={range} /></Field>
      </div>
      <div className="grid grid-cols-[minmax(180px,0.35fr)_minmax(0,1fr)] items-end gap-4 min-w-0 max-[900px]:grid-cols-1">
        <Field label={t('dashboard.performance.groupBy.label')}>
          <div className="flex items-center gap-2">
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
        </Field>
        <PerformanceFiltersBar filters={filters} groupBy={groupBy} overview={overview} upstreamNames={upstreamNames} view={view} onChange={setFilter} />
      </div>
      <div className="grid gap-2.5 grid-cols-8 max-[1150px]:grid-cols-4 max-[620px]:grid-cols-2">
        {summaryCards.map(([label, value]) => <div className="grid gap-1 min-w-0 px-2 py-1" key={label}>
          <Text size={200} weight="semibold" className="text-fui-fg2 leading-[1.2]">{t(`dashboard.performance.summary.${label}`)}</Text>
          <Text size={500} weight="semibold" className="tabular-nums overflow-wrap-anywhere">{value}</Text>
        </div>)}
      </div>
    </Panel>
    <Panel className="!grid gap-[18px] min-w-0 !p-[18px]">
      <PerformanceChartSection chart={chart} hidden={hiddenSeries} onHiddenChange={setHiddenSeries} title={t('dashboard.performance.chartTitle', { metric: t(`dashboard.performance.metric.${metric === 'ttft' ? 'ttft' : 'outputSpeed'}`), group: t(`dashboard.performance.groupBy.${groupBy}`), percentile })} />
    </Panel>
    <Panel className="!grid gap-3 !p-[18px] min-w-0">
      <ScrollArea axes="horizontal" className="min-w-0"><TabList selectedValue={activeBreakdown.key} onTabSelect={(_, data) => setBreakdownGroup(data.value as PerformanceGroupBy)}>
        {breakdowns.map(({ key }) => <Tab key={key} value={key}>{t(`dashboard.performance.groupBy.${key}`)}</Tab>)}
      </TabList></ScrollArea>
      <PerformanceTable groupBy={activeBreakdown.key} overview={overview} rows={activeBreakdown.rows} showTitle={false} upstreamNames={upstreamNames} />
    </Panel>
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
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 min-w-0">
    {entries.filter(({ key }) => {
      if (key === 'userId' && view !== 'all-by-user') return false;
      if ((key === 'userId' || key === 'keyId') && (groupBy === 'userId' || groupBy === 'keyId')) return false;
      return key !== groupBy;
    }).map(({ key, values }) => <Field key={key} label={t(`dashboard.performance.filters.${key}`)}>
      <Select aria-label={t(`dashboard.performance.filters.${key}`)} value={filters[key]} onChange={(_, data) => onChange(key, data.value)}>
        <option value="">{t(`dashboard.performance.filters.all.${key}`)}</option>
        {values.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </Select>
    </Field>)}
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
  const chartRootStyles = useUnclippedChartFrame();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(host);
  const locale = localeForLanguage(i18n.language);
  const formatter = chart.metric === 'ttft' ? formatDuration : formatRate;
  const visibleLegends = chart.entries.filter(entry => !hidden.has(entry.id)).map(entry => entry.label);
  const visibleData = useMemo<ChartProps>(() => ({ ...chart.data, lineChartData: chart.data.lineChartData?.filter(series => visibleLegends.includes(series.legend)) }), [chart.data, visibleLegends]);
  const values = visibleData.lineChartData?.flatMap(series => series.data.map(point => point.y).filter((value): value is number => typeof value === 'number' && value > 0)) ?? [];
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const callout = useCallback((props?: CustomizedCalloutData): ReactElement | null => !props?.values.length
    ? null
    : <PerformanceChartCallout
        data={props}
        formatter={formatter}
        title={formatCalloutTitle(props.x, labelByTime, chart.range, locale)}
      />, [chart.range, formatter, labelByTime, locale]);
  const plotHeight = Math.max(0, size.height - chartMargins.top - chartMargins.bottom);
  return <div className={`${chartStyles.root} h-[320px] min-w-0 w-full`} ref={setHost}>{size.width < 120 ? null : visibleData.lineChartData?.length ? <LineChart styles={chartRootStyles} customDateTimeFormatter={date => formatAxisDate(date, chart.range, locale)} data={visibleData} height={size.height} hideLegend margins={chartMargins} onRenderCalloutPerStack={callout} tickValues={chartTickValues(chart.buckets).map(bucket => bucket.date)} width={size.width} xAxistickSize={-plotHeight} yAxisTickFormat={(value: number) => labelledOnLogAxis(value) ? formatter(value) : ''} yMaxValue={values.length ? Math.max(...values) : undefined} yMinValue={values.length ? Math.min(...values) : undefined} yScaleType="log" /> : <div className={stateStyles.root}>{t('dashboard.performance.empty')}</div>}</div>;
}

function PerformanceChartCallout({ data, formatter, title }: {
  data: CustomizedCalloutData;
  formatter: (value: number) => string;
  title: string;
}) {
  const rows = data.values
    .filter(item => item.y > 0)
    .toSorted((left, right) => right.y - left.y);

  return (
    <div className="grid gap-1 w-[min(230px,calc(100vw-48px))] min-w-0 max-w-[360px]">
      <Text block size={200} weight="semibold">{title}</Text>
      <div className="grid gap-1">
        {rows.map(item => (
          <div className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-1.5 min-w-0" key={item.legend}>
            <span
              aria-hidden
              className="block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <Text block size={100} className="truncate" title={item.legend}>{item.legend}</Text>
            <Text block size={100} weight="semibold" className="tabular-nums text-right whitespace-nowrap">
              {formatter(item.y)}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceTable({ groupBy, overview, rows, showTitle = true, upstreamNames }: { groupBy: PerformanceGroupBy; overview: PerformanceOverviewResponse; rows: PerformanceDisplayRecord[]; showTitle?: boolean; upstreamNames: ReadonlyMap<string, string> }) {
  const { i18n, t } = useTranslation();
  const locale = localeForLanguage(i18n.language);
  const styles = usePerformanceTableStyles();
  const [sort, setSort] = useState<{ direction: 'ascending' | 'descending'; key: PerformanceTableSortKey }>({ direction: 'descending', key: 'requests' });
  const sortBy = (key: PerformanceTableSortKey) => setSort(current => current.key === key
    ? { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
    : { key, direction: key === 'group' ? 'ascending' : 'descending' });
  const sortedRows = useMemo(() => rows.toSorted((left, right) => {
    const leftValue = performanceTableSortValue(left, sort.key, groupBy, overview, upstreamNames);
    const rightValue = performanceTableSortValue(right, sort.key, groupBy, overview, upstreamNames);
    const order = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue);
    return sort.direction === 'ascending' ? order : -order;
  }), [groupBy, overview, rows, sort, upstreamNames]);
  const sortDirection = (key: PerformanceTableSortKey) => sort.key === key ? sort.direction : undefined;
  return <section className="grid gap-2.5 min-w-0">
    {showTitle && <Text size={300} weight="semibold">{t(`dashboard.performance.groupBy.${groupBy}`)}</Text>}
    <ScrollArea axes="horizontal" className="border border-fui-stroke1 rounded-lg min-w-0"><Table aria-label={t(`dashboard.performance.groupBy.${groupBy}`)} size="small" className="min-w-[570px]">
      {/* Fluent's Table lays out `fixed`, so columns split evenly unless the
          first row states a width: every column landed on the same 116px, which
          wrapped the longest header onto two lines and clipped model ids to
          `claude-opus-...`, hiding which of 4.6/4.7/4.8 a row described. Sizing
          the four measure columns to their widest label leaves the rest to the
          name, which is the only column whose content has no bound. */}
      <TableHeader><TableRow><TableHeaderCell sortable sortDirection={sortDirection('group')} onClick={() => sortBy('group')}>{t(`dashboard.performance.filters.${groupBy}`)}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('requests')} onClick={() => sortBy('requests')} className={`${styles.numericHeader} !text-right !w-[112px]`}>{t('dashboard.performance.tables.requests')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('errors')} onClick={() => sortBy('errors')} className={`${styles.numericHeader} !text-right !w-[88px]`}>{t('dashboard.performance.tables.errors')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('ttft')} onClick={() => sortBy('ttft')} className={`${styles.numericHeader} !text-right !w-[112px]`}>{t('dashboard.performance.tables.ttftP95')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('speed')} onClick={() => sortBy('speed')} className={`${styles.numericHeader} !text-right !w-[160px]`}>{t('dashboard.performance.tables.speedP95')}</TableHeaderCell></TableRow></TableHeader>
      <TableBody>{sortedRows.length ? sortedRows.map(row => <TableRow key={row.group}><TableCell><span className="block overflow-hidden text-ellipsis whitespace-nowrap" title={row.group}>{resolvePerformanceGroup(row.group, groupBy, overview, upstreamNames)}</span></TableCell><TableCell className="!text-right tabular-nums">{formatCount(row.requests, locale)}</TableCell><TableCell className="!text-right tabular-nums">{formatCount(row.errors, locale)}</TableCell><TableCell className="!text-right tabular-nums">{formatDuration(row.ttftMsP95)}</TableCell><TableCell className="!text-right tabular-nums">{formatTokensPerSecond(row.tpotUsP95)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5}><Text size={200} className="text-fui-fg2">{t('dashboard.performance.empty')}</Text></TableCell></TableRow>}</TableBody>
    </Table></ScrollArea>
  </section>;
}

type PerformanceTableSortKey = 'group' | 'requests' | 'errors' | 'ttft' | 'speed';

const performanceTableSortValue = (row: PerformanceDisplayRecord, key: PerformanceTableSortKey, groupBy: PerformanceGroupBy, overview: PerformanceOverviewResponse, upstreamNames: ReadonlyMap<string, string>): string | number => {
  if (key === 'group') return resolvePerformanceGroup(row.group, groupBy, overview, upstreamNames);
  if (key === 'requests' || key === 'errors') return row[key];
  if (key === 'ttft') return row.ttftMsP95 ?? Number.NEGATIVE_INFINITY;
  return row.tpotUsP95 !== null && row.tpotUsP95 > 0 ? 1_000_000 / row.tpotUsP95 : Number.NEGATIVE_INFINITY;
};

function buildPerformanceChart(records: PerformanceDisplayRecord[], metric: PerformanceMetric, percentile: PerformancePercentile, groupBy: PerformanceGroupBy, overview: PerformanceOverviewResponse, upstreamNames: ReadonlyMap<string, string>, buckets: Bucket[], range: PerformanceRange): PerformanceChartModel {
  const groups = [...new Set(records.map(record => record.group))].sort();
  const entries = groups.map((group, colorSlot) => ({ id: group, label: resolvePerformanceGroup(group, groupBy, overview, upstreamNames), colorSlot }));
  const values = new Map(records.map(record => [`${record.bucket}\0${record.group}`, record]));
  return {
    entries, buckets, range, metric, data: {
      chartTitle: '', lineChartData: entries.flatMap(entry => {
        const data = buckets.flatMap(bucket => { const value = values.get(`${bucket.key}\0${entry.id}`); const y = value ? performanceValue(value, metric, percentile) : null; return y === null || y <= 0 ? [] : [{ x: bucket.date, y }]; });
        return data.length ? [{ legend: entry.label, color: colorForSlot(entry.colorSlot), lineOptions: { strokeWidth: 2, curve: curveMonotoneX, mode: 'lines+markers' }, data: data.map(point => ({ ...point, markerSize: 4 })) }] : [];
      }),
    },
  };
}

const performanceBuckets = (range: PerformanceRange, now: number, locale: string): Bucket[] =>
  dashboardBucketFrames(range, now).map(({ date, key }) => ({
    key,
    date,
    label: range === 'today'
      ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : range === '7d'
        ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit' })
        : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
  }));
function formatDuration(ms: number | null) { if (ms === null || !Number.isFinite(ms)) return '-'; if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`; if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`; return `${Math.round(ms)}ms`; }
function formatRate(value: number | null) { if (value === null || !Number.isFinite(value) || value <= 0) return '-'; return value >= 100 ? `${Math.round(value)} tok/s` : value >= 10 ? `${value.toFixed(1)} tok/s` : `${value.toFixed(2)} tok/s`; }
const formatTokensPerSecond = (us: number | null) => us === null || us <= 0 ? '-' : formatRate(1_000_000 / us);
const formatCount = (value: number, locale: string) => Math.max(0, Math.round(value)).toLocaleString(locale);
