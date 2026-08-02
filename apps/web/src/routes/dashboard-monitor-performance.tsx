import { LineChart, type ChartProps, type CustomizedCalloutData } from '@fluentui/react-charts';
import { InfoRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect, useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-performance';
import { revalidateOnPathnameChange } from './revalidation';
import { requireDashboardSession } from './route-guards';
import { api, callApi, type GlobalError } from '../api/client';
import { ChartCalloutTable } from '../components/charts/chart-callout-table';
import { useUnclippedChartFrame } from '../components/charts/chart-frame-styles';
import { ChartSection } from '../components/charts/chart-section';
import { useChartStateStyles } from '../components/charts/chart-state-styles';
import type { ChartBucket } from '../components/charts/dashboard-time';
import { chartTickValues, dashboardBucketFrames, formatAxisDate, formatCalloutTitle } from '../components/charts/dashboard-time';
import type { ChartSeries } from '../components/charts/series-legends';
import { useElementSize } from '../components/charts/use-element-size';
import { buildPerformanceChart, type PerformanceChartModel, type PerformanceChartPointDetails } from '../components/performance/performance-chart-model';
import {
  buildPerformanceQuery,
  clearGroupedFilter,
  parsePerformanceUrlState,
  performanceLabels,
  resolvePerformanceGroup,
  serializePerformanceUrlState,
  type PerformanceDisplayRecord,
  type PerformanceFilters,
  type PerformanceGroupBy,
  type PerformanceLabels,
  type PerformanceMetric,
  type PerformanceOverviewResponse,
  type PerformancePercentile,
  type PerformanceRange,
  type PerformanceView,
} from '../components/performance/performance-data';
import { ChoiceGroup } from '../components/ui/choice-group';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Dropdown } from '../components/ui/fluent-form-controls';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { fluentComponents } from '../fluent';
import { formatDuration } from '../lib/format-duration';
import { formatCount, formatTokenRate, formatTokenRateFromTpot } from '../lib/format-number';
import { useLocale } from '../lib/use-locale';
import { useAuthStore } from '../stores/auth-store';

const {
  Button, Field, Option, Tab, TabList, makeStyles,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip,
} = fluentComponents;

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

// WinUI ships no chart, so the marks inside the plot are read against Fluent's
// line chart rather than transcribed from a dictionary. What this layer settles
// is how large a data point is drawn and which of Fluent's hover affordances
// answers the pointer.
//
// A series here carries `mode: 'lines+markers'` over a monotone curve, which
// puts Fluent on its curve branch: the line is a single path, every point is a
// marker circle whose fill and stroke are both the series colour, and one
// highlight circle per series is parked offscreen and moved under the pointer.
// Radius and stroke width together give the dot its diameter -- 2px of radius
// inside a 1.5px stroke reads as 5.5px beside the 2px line -- and they hold in
// every state, because the pointer is answered at an x position rather than at
// one series' point.
//
// That answer is the vertical line plus a callout, and the callout is a table
// of every series at that x. Fluent's highlight circle singles one of them out,
// which would contradict the table standing next to it, so it is not painted.
// It has to lose its paint rather than its box: Fluent anchors the callout to
// this circle's bounding rect, which `visibility` leaves in place and `display`
// would collapse onto the plot's origin. A hidden element also takes no pointer
// input, so the markers and the line underneath keep theirs.
//
// The x axis draws its ticks at the plot's full height so that they double as
// gridlines, which lays a full-height stroke across every series. Hit testing
// has to pass through those strokes, or a pointer crossing one leaves the
// series beneath it unanswered.
//
// No rule here states a colour, so both colour schemes and a forced palette are
// left to Fluent, which paints the marks in the series colours the chart
// palette hands it.
const usePerformanceChartStyles = makeStyles({
  root: {
    '& .fui-cart__xAxis line': { pointerEvents: 'none' },
    '& circle:not([id*="staticHighlightCircle"])': { r: '2px !important', strokeWidth: '1.5px' },
    '& circle[id*="staticHighlightCircle"]': { visibility: 'hidden' },
  },
});
const usePerformanceTableStyles = makeStyles({
  numericHeader: {
    whiteSpace: 'nowrap',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end', whiteSpace: 'nowrap' },
  },
  // The truncated group name is the cell's tooltip trigger and therefore a tab
  // stop of its own, so it draws its own focus visual: the cell around it takes
  // no focus, and the ring the layer gives a table cell never fires. WinUI's is
  // a 2px FocusStrokeColorOuter ring with 1px of FocusStrokeColorInner
  // immediately inside it. Both are drawn inside the name's own box, because
  // the cell clips whatever leaves it -- the outline covers the outer two of
  // the shadow's three pixels, which leaves the inner ring as the third. Each
  // stroke is stated per theme in the dictionaries and reached through the
  // custom property, so the one declaration serves both schemes; under a forced
  // palette the user agent drops the shadow and paints the outline in the
  // system focus colour.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
  groupName: {
    ':focus-visible': {
      boxShadow: 'inset 0 0 0 3px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '-2px',
    },
  },
});

interface LoaderData {
  error: GlobalError | null;
  loadedAt: number;
  // `null` is a failed fetch, not a quiet gateway. An empty overview renders
  // eight zeroes and a table that says nobody sent a request, which is a
  // telemetry page asserting something it does not know.
  overview: PerformanceOverviewResponse | null;
  state: ReturnType<typeof parsePerformanceUrlState>;
  upstreamNames: UpstreamName[];
  view: PerformanceView;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  requireDashboardSession();
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
    error: overview.error ?? upstreams.error ?? null,
    loadedAt,
    overview: overview.data ?? null,
    state: { ...state, groupBy },
    upstreamNames: upstreams.data ?? [],
    view,
  };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Performance | Floway' }];
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardMonitorPerformance({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
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
  const [overview, setOverview] = useState<PerformanceOverviewResponse | null>(loaderData.overview);
  const [upstreamNames] = useState(() => new Map(loaderData.upstreamNames.map(record => [record.id, record.name])));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const locale = useLocale();

  // A background poll must not clear a failure the operator has not read:
  // these pages reload themselves every minute, and wiping the bar on the way
  // in meant a server's own words could appear and vanish unseen.
  const refresh = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const requestedAt = Date.now();
    setLoading(true);
    if (!background) setError(null);
    const search = buildPerformanceQuery(view, range, groupBy, filters, requestedAt);
    const result = await callApi(() => api.api.performance.overview.$get(
      { query: Object.fromEntries(search) },
      { init: { signal: controller.signal } },
    ));
    if (requestRef.current !== controller) return;
    requestRef.current = null;
    if (result.error) setError(result.error);
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
    return () => { requestRef.current?.abort(); };
  }, [refresh]);

  usePollWhileVisible(refresh, 60_000);

  // The session is gone, not the page: the gateway said so with a status, and
  // only the status says it -- a 401 body carrying its own words never matches
  // a message comparison.
  useEffect(() => { if (error?.status === 401) clearAuth(); }, [clearAuth, error]);

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
  const labels = useMemo(() => overview && performanceLabels(overview, upstreamNames), [overview, upstreamNames]);
  const chart = useMemo(() => overview && labels && buildPerformanceChart(overview.series, metric, percentile, groupBy, labels, buckets, loadedRange), [buckets, groupBy, labels, loadedRange, metric, overview, percentile]);
  const summary = overview?.axes.none[0];
  const summaryCards = [
    ['requests', formatCount(summary?.requests ?? 0, locale)],
    ['errors', formatCount(summary?.errors ?? 0, locale)],
    ['ttftP50', formatDuration(summary?.ttftMsP50 ?? null)],
    ['speedP50', formatTokenRateFromTpot(summary?.tpotUsP50 ?? null)],
    ['ttftP95', formatDuration(summary?.ttftMsP95 ?? null)],
    ['speedP95', formatTokenRateFromTpot(summary?.tpotUsP95 ?? null)],
    ['ttftP99', formatDuration(summary?.ttftMsP99 ?? null)],
    ['speedP99', formatTokenRateFromTpot(summary?.tpotUsP99 ?? null)],
  ] as const;
  const breakdowns = overview === null ? [] : groupByValues
    .filter(key => key !== 'userId' || view === 'all-by-user')
    .map(key => ({ key, rows: overview.axes[key] }));
  const activeBreakdown = breakdowns.find(item => item.key === breakdownGroup) ?? breakdowns[0];

  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions appearance="subtle" onRefresh={() => void refresh()} refreshLabel={t('dashboard.performance.actions.refresh')} refreshing={loading} />}
      description={t('dashboard.pages.performance')}
      title={t('dashboard.nav.performance')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}
    {overview === null || chart === null || labels === null || activeBreakdown === undefined ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
      <Panel className="!grid min-w-0">
        <div className="flex items-end gap-3 min-w-0 flex-wrap">
          <Field className="w-[160px] flex-none" label={t('dashboard.performance.groupBy.label')}>
            <div className="flex items-center gap-2">
              <Dropdown
                aria-label={t('dashboard.performance.groupBy.label')}
                className="!min-w-0 flex-1"
                selectedOptions={[groupBy]}
                value={t(`dashboard.performance.groupBy.${groupBy}`)}
                onOptionSelect={(_, data) => data.optionValue !== undefined && changeGroupBy(data.optionValue as PerformanceGroupBy)}
              >
                {groupByValues.filter(value => value !== 'userId' || view === 'all-by-user').map(value => <Option key={value} value={value}>{t(`dashboard.performance.groupBy.${value}`)}</Option>)}
              </Dropdown>
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
          <PerformanceFilterFields filters={filters} groupBy={groupBy} labels={labels} overview={overview} view={view} onChange={setFilter} />
        </div>
        <div className="grid gap-2.5 grid-cols-8 max-[1150px]:grid-cols-4 max-[620px]:grid-cols-2">
          {summaryCards.map(([label, value]) => <div className="grid gap-1 min-w-0 px-2 py-1" key={label}>
            <Text size={200} weight="semibold" className="text-fui-fg2">{t(`dashboard.performance.summary.${label}`)}</Text>
            <Text size={500} weight="semibold" className="tabular-nums overflow-wrap-anywhere">{value}</Text>
          </div>)}
        </div>
        <div className="flex items-center justify-between gap-4 min-w-0 flex-wrap">
          <ChoiceGroup ariaLabel={t('dashboard.performance.metric.label')} items={[
            { value: 'ttft', label: t('dashboard.performance.metric.ttft') },
            { value: 'tokPerSec', label: t('dashboard.performance.metric.outputSpeed') },
          ]} onChange={value => setMetric(value as PerformanceMetric)} value={metric} />
          <ChoiceGroup ariaLabel={t('dashboard.performance.percentile.label')} items={(['p50', 'p95', 'p99'] as const).map(value => ({ value, label: value }))} onChange={value => setPercentile(value as PerformancePercentile)} value={percentile} />
          <ChoiceGroup ariaLabel={t('dashboard.performance.range.label')} items={[
            { value: 'today', label: t('dashboard.performance.range.today') }, { value: '7d', label: t('dashboard.performance.range.sevenDays') }, { value: '30d', label: t('dashboard.performance.range.thirtyDays') },
          ]} onChange={value => setRange(value as PerformanceRange)} value={range} />
        </div>
      </Panel>
      <Panel className="!grid !gap-[18px] min-w-0">
        <PerformanceChartSection chart={chart} hidden={hiddenSeries} onHiddenChange={setHiddenSeries} title={t('dashboard.performance.chartTitle', { metric: t(`dashboard.performance.metric.${metric === 'ttft' ? 'ttft' : 'outputSpeed'}`), group: t(`dashboard.performance.groupBy.${groupBy}`), percentile })} />
      </Panel>
      <Panel className="!grid !gap-3 min-w-0">
        {/* The tabs sit flush against the scrollport on the block axis, so the
            2px ring a focused tab paints has nowhere to go. The gutter is on
            the scrollport, which is the box that clips, and the host takes the
            same distance back off its margin so the row still lines up with the
            panel. Not an inward ring: it would land on the tab's own selection
            pipe. */}
        <ScrollArea axes="horizontal" className="min-w-0 -m-0.5" viewportClassName="p-0.5"><TabList selectedValue={activeBreakdown.key} onTabSelect={(_, data) => setBreakdownGroup(data.value as PerformanceGroupBy)}>
          {breakdowns.map(({ key }) => <Tab key={key} value={key}>{t(`dashboard.performance.groupBy.${key}`)}</Tab>)}
        </TabList></ScrollArea>
        <PerformanceTable groupBy={activeBreakdown.key} labels={labels} rows={activeBreakdown.rows} />
      </Panel>
    </>}
  </section>;
}

function PerformanceFilterFields({ filters, groupBy, labels, onChange, overview, view }: {
  filters: PerformanceFilters; groupBy: PerformanceGroupBy; labels: PerformanceLabels;
  onChange: (key: keyof PerformanceFilters, value: string) => void;
  overview: PerformanceOverviewResponse; view: PerformanceView;
}) {
  const { t } = useTranslation();
  const entries: Array<{ key: keyof PerformanceFilters; values: Array<{ value: string; label: string }> }> = [
    { key: 'model', values: overview.dimensionValues.models.map(value => ({ value, label: value })) },
    { key: 'upstream', values: overview.dimensionValues.upstreams.map(value => ({ value, label: labels.upstreams.get(value) ?? value })) },
    { key: 'operation', values: overview.dimensionValues.operations.map(value => ({ value, label: value })) },
    { key: 'runtimeLocation', values: overview.dimensionValues.runtimeLocations.map(value => ({ value, label: value })) },
    { key: 'userId', values: overview.dimensionValues.userIds.map(value => ({ value: String(value), label: labels.users.get(String(value)) ?? `user ${value}` })) },
    { key: 'keyId', values: overview.dimensionValues.keyIds.map(value => ({ value, label: labels.keys.get(value) ?? value })) },
  ];
  return <>
    {entries.filter(({ key }) => {
      if (key === 'userId' && view !== 'all-by-user') return false;
      if ((key === 'userId' || key === 'keyId') && (groupBy === 'userId' || groupBy === 'keyId')) return false;
      return key !== groupBy;
    }).map(({ key, values }) => <Field className="min-w-[150px] flex-[1_1_150px]" key={key} label={t(`dashboard.performance.filters.${key}`)}>
      <Dropdown
        aria-label={t(`dashboard.performance.filters.${key}`)}
        className="!min-w-0 w-full"
        selectedOptions={[filters[key]]}
        value={filters[key] === '' ? t(`dashboard.performance.filters.all.${key}`) : values.find(item => item.value === filters[key])?.label ?? filters[key]}
        onOptionSelect={(_, data) => data.optionValue !== undefined && onChange(key, data.optionValue)}
      >
        <Option value="">{t(`dashboard.performance.filters.all.${key}`)}</Option>
        {values.map(item => <Option key={item.value} value={item.value}>{item.label}</Option>)}
      </Dropdown>
    </Field>)}
  </>;
}

function PerformanceChartSection({ chart, hidden, onHiddenChange, title }: { chart: PerformanceChartModel; hidden: Set<string>; onHiddenChange: (next: Set<string>) => void; title: string }) {
  const { t } = useTranslation();
  return <ChartSection controlsLabel={t('dashboard.performance.series.label')} emptyText={t('dashboard.performance.empty')} entries={chart.entries} hidden={hidden} onHiddenChange={onHiddenChange} title={title}>
    <PerformanceChart chart={chart} hidden={hidden} />
  </ChartSection>;
}

function PerformanceChart({ chart, hidden }: { chart: PerformanceChartModel; hidden: Set<string> }) {
  const { t } = useTranslation();
  const stateStyles = useChartStateStyles();
  const chartStyles = usePerformanceChartStyles();
  const chartRootStyles = useUnclippedChartFrame();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(host);
  const locale = useLocale();
  const formatter = chart.metric === 'ttft' ? formatDuration : formatTokenRate;
  const entryByLegend = useMemo(() => new Map(chart.entries.map(entry => [entry.legend, entry])), [chart.entries]);
  const visibleLegends = useMemo(() => new Set(chart.entries.filter(entry => !hidden.has(entry.id)).map(entry => entry.legend)), [chart.entries, hidden]);
  const visibleData = useMemo<ChartProps>(() => ({ ...chart.data, lineChartData: chart.data.lineChartData?.filter(series => visibleLegends.has(series.legend)) }), [chart.data, visibleLegends]);
  const values = visibleData.lineChartData?.flatMap(series => series.data.map(point => point.y).filter((value): value is number => typeof value === 'number' && value > 0)) ?? [];
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const callout = useCallback((props?: CustomizedCalloutData): ReactElement | null => !props?.values.length
    ? null
    : <PerformanceChartCallout
        data={props}
        details={chart.details.get(props.x instanceof Date ? props.x.getTime() : Number(props.x))}
        entryByLegend={entryByLegend}
        title={formatCalloutTitle(props.x, labelByTime, chart.range, locale)}
      />, [chart.details, chart.range, entryByLegend, labelByTime, locale]);
  const plotHeight = Math.max(0, size.height - chartMargins.top - chartMargins.bottom);
  return <div className={`${chartStyles.root} h-[320px] min-w-0 w-full`} ref={setHost}>{size.width < 120 ? null : visibleData.lineChartData?.length ? <LineChart styles={chartRootStyles} customDateTimeFormatter={date => formatAxisDate(date, chart.range, locale)} data={visibleData} enablePerfOptimization height={size.height} hideLegend margins={chartMargins} onRenderCalloutPerStack={callout} tickValues={chartTickValues(chart.buckets).map(bucket => bucket.date)} width={size.width} xAxistickSize={-plotHeight} yAxisTickFormat={(value: number) => labelledOnLogAxis(value) ? formatter(value) : ''} yMaxValue={values.length ? Math.max(...values) : undefined} yMinValue={values.length ? Math.min(...values) : undefined} yScaleType="log" /> : <div className={stateStyles.root}>{t('dashboard.performance.empty')}</div>}</div>;
}

function PerformanceChartCallout({ data, details, entryByLegend, title }: {
  data: CustomizedCalloutData;
  details: ReadonlyMap<string, PerformanceChartPointDetails> | undefined;
  entryByLegend: ReadonlyMap<string, ChartSeries>;
  title: string;
}) {
  const { t } = useTranslation();
  // A callout can outlive the data it described: the chart keeps its own hover
  // state across a range or metric switch and asks for a callout carrying
  // legends from the dataset that has just been replaced. Such a row no longer
  // exists, so it is dropped rather than substituted -- a table describing the
  // data must not name a series the data does not have.
  const rows = data.values
    .filter(item => item.y > 0)
    .toSorted((left, right) => right.y - left.y)
    .flatMap(item => {
      const entry = entryByLegend.get(item.legend);
      if (!entry) return [];
      const point = details?.get(entry.id);
      return [{
        color: item.color,
        key: entry.id,
        label: entry.label,
        values: [formatDuration(point?.ttft ?? null), formatTokenRate(point?.outputSpeed ?? null)],
      }];
    });

  if (rows.length === 0) return null;

  return (
    <ScrollArea axes="horizontal" className="max-w-[min(420px,calc(100vw-48px))] min-w-[300px]" contentClassName="grid gap-1">
      <ChartCalloutTable
        columns={[
          { key: 'ttft', label: t('dashboard.performance.metric.ttft') },
          { key: 'outputSpeed', label: t('dashboard.performance.metric.outputSpeed') },
        ]}
        rows={rows}
        title={title}
      />
    </ScrollArea>
  );
}

function PerformanceTable({ groupBy, labels, rows }: { groupBy: PerformanceGroupBy; labels: PerformanceLabels; rows: PerformanceDisplayRecord[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = usePerformanceTableStyles();
  const [sort, setSort] = useState<{ direction: 'ascending' | 'descending'; key: PerformanceTableSortKey }>({ direction: 'descending', key: 'requests' });
  const sortBy = (key: PerformanceTableSortKey) => setSort(current => current.key === key
    ? { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
    : { key, direction: key === 'group' ? 'ascending' : 'descending' });
  const sortedRows = useMemo(() => rows.toSorted((left, right) => {
    const leftValue = performanceTableSortValue(left, sort.key, groupBy, labels);
    const rightValue = performanceTableSortValue(right, sort.key, groupBy, labels);
    const order = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue);
    return sort.direction === 'ascending' ? order : -order;
  }), [groupBy, labels, rows, sort]);
  const sortDirection = (key: PerformanceTableSortKey) => sort.key === key ? sort.direction : undefined;
  return <section className="grid gap-2.5 min-w-0">
    <ScrollArea axes="horizontal" className="border border-fui-stroke1 rounded-lg min-w-0"><Table aria-label={t(`dashboard.performance.groupBy.${groupBy}`)} size="small" className="min-w-[570px]">
      {/* Fluent's Table lays out `fixed`, so columns split evenly unless the
          first row states a width: every column landed on the same 116px, which
          wrapped the longest header onto two lines and clipped model ids to
          `claude-opus-...`, hiding which of 4.6/4.7/4.8 a row described. Sizing
          the four measure columns to their widest label leaves the rest to the
          name, which is the only column whose content has no bound. */}
      <TableHeader><TableRow><TableHeaderCell sortable sortDirection={sortDirection('group')} onClick={() => sortBy('group')}>{t(`dashboard.performance.filters.${groupBy}`)}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('requests')} onClick={() => sortBy('requests')} className={`${styles.numericHeader} text-right !w-[112px]`}>{t('dashboard.performance.tables.requests')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('errors')} onClick={() => sortBy('errors')} className={`${styles.numericHeader} text-right !w-[88px]`}>{t('dashboard.performance.tables.errors')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('ttft')} onClick={() => sortBy('ttft')} className={`${styles.numericHeader} text-right !w-[112px]`}>{t('dashboard.performance.tables.ttftP95')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('speed')} onClick={() => sortBy('speed')} className={`${styles.numericHeader} text-right !w-[160px]`}>{t('dashboard.performance.tables.speedP95')}</TableHeaderCell></TableRow></TableHeader>
      <TableBody>{sortedRows.length ? sortedRows.map(row => <TableRow key={row.group}><TableCell><Tooltip content={row.group} relationship="description"><span className={`${styles.groupName} block overflow-hidden text-ellipsis whitespace-nowrap`} tabIndex={0}>{resolvePerformanceGroup(row.group, groupBy, labels)}</span></Tooltip></TableCell><TableCell className="text-right tabular-nums">{formatCount(row.requests, locale)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(row.errors, locale)}</TableCell><TableCell className="text-right tabular-nums">{formatDuration(row.ttftMsP95)}</TableCell><TableCell className="text-right tabular-nums">{formatTokenRateFromTpot(row.tpotUsP95)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5}><EmptyStateLine>{t('dashboard.performance.empty')}</EmptyStateLine></TableCell></TableRow>}</TableBody>
    </Table></ScrollArea>
  </section>;
}

type PerformanceTableSortKey = 'group' | 'requests' | 'errors' | 'ttft' | 'speed';

const performanceTableSortValue = (row: PerformanceDisplayRecord, key: PerformanceTableSortKey, groupBy: PerformanceGroupBy, labels: PerformanceLabels): string | number => {
  if (key === 'group') return resolvePerformanceGroup(row.group, groupBy, labels);
  if (key === 'requests' || key === 'errors') return row[key];
  if (key === 'ttft') return row.ttftMsP95 ?? Number.NEGATIVE_INFINITY;
  return row.tpotUsP95 !== null && row.tpotUsP95 > 0 ? 1_000_000 / row.tpotUsP95 : Number.NEGATIVE_INFINITY;
};

const performanceBuckets = (range: PerformanceRange, now: number, locale: string): ChartBucket[] =>
  dashboardBucketFrames(range, now).map(({ date, key }) => ({
    key,
    date,
    label: formatAxisDate(date, range, locale),
  }));
