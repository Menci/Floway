import { InfoRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-monitor-performance';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi, type GlobalError } from '../api/client';
import { dashboardChartBuckets, sameDashboardRange } from '../components/charts/dashboard-time';
import { PerformanceChartSection } from '../components/performance/chart';
import { createPerformanceLoader, performanceOverviewForDisplay, performanceRanking, type PerformanceDataset, type PerformanceQuery } from '../components/performance/data';
import {
  normalizePerformanceBreakdownForRuntime,
  normalizePerformanceDimensionsForRuntime,
  parsePerformanceUrlState,
  performanceLabels,
  performancePercentiles,
  performancePercentileTailOf,
  serializePerformanceUrlState,
  type PerformanceFilters,
  type PerformanceGroupBy,
  type PerformanceMetric,
  type PerformanceOverviewView,
  type PerformancePercentile,
  type PerformanceRange,
  type PerformanceTableSort,
  type PerformanceUrlState,
} from '../components/performance/overview';
import { buildPerformanceChart } from '../components/performance/plot';
import { PerformanceTable } from '../components/performance/table';
import { TelemetryFilterFields, TelemetryGroupByField, type TelemetryDimension } from '../components/telemetry/dimension-controls';
import { changeTelemetryFilter, changeTelemetryGroupBy, scopeTelemetryIdentity } from '../components/telemetry/filter-state';
import { TelemetryTimeRange } from '../components/telemetry/time-range';
import { useTelemetryPolling } from '../components/telemetry/use-poll';
import { ChoiceGroup } from '../components/ui/choice-group';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { CONTROL_ROW_CLASS, PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { useRefresh, useRefreshOnChange } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { formatDuration } from '../lib/format-duration';
import { formatCount, formatTokenRateFromTpot } from '../lib/format-number';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';

const { Button, Spinner, Tab, TabList, Text, Tooltip } = fluentComponents;

interface LoaderData {
  currentUserId: string;
  error: GlobalError | null;
  loadedAt: number;
  // `null` is a failed fetch, not a quiet gateway: an empty overview would
  // render zeroes the page does not know to be true.
  overview: PerformanceOverviewView | null;
  dataset?: PerformanceDataset | undefined;
  state: PerformanceUrlState;
  regionAvailable: boolean | null;
}

type RankingRead = {
  dimension: PerformanceGroupBy;
  query: PerformanceQuery;
  requestedAt: number;
  scopeKey: string | undefined;
};

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  const user = await requireDashboardUser();
  const parsed = parsePerformanceUrlState(new URL(request.url).searchParams);
  const scoped = scopeTelemetryIdentity(parsed.groupBy, parsed.filters, {
    currentUserId: String(user.id),
    fallbackGroup: 'model',
    userDimensionAvailable: true,
  });
  const loadedAt = Date.now();
  const requestedState = { ...parsed, ...scoped };
  const performanceLoader = createPerformanceLoader();
  const [initialOverview, runtime] = await Promise.all([
    performanceLoader.load(requestedState, requestedState.groupBy, loadedAt),
    callApi(() => api.api['runtime-info'].$get()),
  ]);
  const regionAvailable = runtime.error ? null : runtime.data.kind === 'cloudflare';
  const normalization = regionAvailable === null
    ? { changed: false, state: requestedState }
    : normalizePerformanceDimensionsForRuntime(requestedState, regionAvailable);
  const state = {
    ...normalization.state,
    breakdown: regionAvailable === null ? normalization.state.breakdown : normalizePerformanceBreakdownForRuntime(normalization.state.breakdown, regionAvailable),
  };
  const overview = !normalization.changed
    ? initialOverview
    : await performanceLoader.load(normalization.state, normalization.state.groupBy, loadedAt);
  return {
    currentUserId: String(user.id),
    error: overview.error ?? runtime.error ?? null,
    loadedAt,
    overview: overview.data === undefined ? null : performanceOverviewForDisplay(overview.data),
    dataset: overview.data,
    regionAvailable,
    state,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardMonitorPerformance({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  const initialState = loaderData.state;
  const [performanceLoader] = useState(() => createPerformanceLoader(loaderData.dataset));
  const [regionAvailable, setRegionAvailable] = useState(loaderData.regionAvailable);
  const [query, setQuery] = useState(() => ({
    filters: initialState.filters,
    groupBy: initialState.groupBy,
    range: initialState.range,
  }));
  const [metric, setMetric] = useState<PerformanceMetric>(initialState.metric);
  const [percentile, setPercentile] = useState<PerformancePercentile>(initialState.percentile);
  const [breakdownGroup, setBreakdownGroup] = useState<PerformanceGroupBy>(initialState.breakdown);
  const [pendingBreakdown, setPendingBreakdown] = useState<PerformanceGroupBy>();
  const [sort, setSort] = useState<PerformanceTableSort>(initialState.sort);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(initialState.hidden));
  const [overview, setOverview] = useState<PerformanceOverviewView | null>(loaderData.overview);
  const [scope, setScope] = useState(() => loaderData.dataset?.snapshot.scope);
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const [ranking, setRanking] = useState<RankingRead>();
  const [rankingFailure, setRankingFailure] = useState<RankingRead & { error: GlobalError }>();
  const pendingRegionAvailableRef = useRef<boolean | null>(null);
  const pageWindow = useRef<{ query: PerformanceQuery; requestedAt: number } | undefined>(undefined);
  const locale = useLocale();
  const identityContext = {
    currentUserId: loaderData.currentUserId,
    fallbackGroup: 'model' as const,
    userDimensionAvailable: true,
  };

  // A background poll must not clear a failure the operator has not read.
  const reload = useCallback(async (signal: AbortSignal, { background, requestedAt }: { background: boolean; requestedAt: number }) => {
    if (!background) setError(null);
    const window = { query, requestedAt };
    pageWindow.current = window;
    const failed = (error?: GlobalError) => {
      if (pageWindow.current === window) pageWindow.current = undefined;
      if (error !== undefined) setError(error);
      return false;
    };
    if (regionAvailable !== null) {
      const result = await performanceLoader.load(query, query.groupBy, requestedAt);
      if (signal.aborted) return failed();
      if (result.error) return failed(result.error);
      setOverview(performanceOverviewForDisplay(result.data));
      setScope(result.data.snapshot.scope);
      return true;
    }

    const discovery = pendingRegionAvailableRef.current === null
      ? await Promise.all([
          performanceLoader.load(query, query.groupBy, requestedAt),
          callApi(() => api.api['runtime-info'].$get({}, { init: { signal } })),
        ]).then(([overviewResult, runtimeResult]) => ({ overviewResult, runtimeResult }))
      : null;
    if (signal.aborted) return failed();
    let nextRegionAvailable: boolean;
    if (pendingRegionAvailableRef.current === null) {
      if (discovery === null) throw new Error('Runtime capability discovery was not started');
      if (discovery.runtimeResult.error) {
        return failed(discovery.overviewResult.error ?? discovery.runtimeResult.error);
      }
      nextRegionAvailable = discovery.runtimeResult.data.kind === 'cloudflare';
      pendingRegionAvailableRef.current = nextRegionAvailable;
    } else {
      nextRegionAvailable = pendingRegionAvailableRef.current;
    }
    const normalization = normalizePerformanceDimensionsForRuntime({
      ...query,
      hidden: [] as string[],
    }, nextRegionAvailable);
    const committedQuery = normalization.changed
      ? {
          filters: normalization.state.filters,
          groupBy: normalization.state.groupBy,
          range: query.range,
        }
      : query;
    let result;
    if (normalization.changed) {
      result = await performanceLoader.load(committedQuery, committedQuery.groupBy, requestedAt);
    } else {
      if (discovery === null) throw new Error('Overview was not loaded with runtime capability discovery');
      result = discovery.overviewResult;
    }
    if (signal.aborted) return failed();
    if (result.error) {
      if (!normalization.changed) {
        pendingRegionAvailableRef.current = null;
        setRegionAvailable(nextRegionAvailable);
      }
      return failed(result.error);
    }
    pendingRegionAvailableRef.current = null;
    setRegionAvailable(nextRegionAvailable);
    setBreakdownGroup(current => normalizePerformanceBreakdownForRuntime(current, nextRegionAvailable));
    setPendingBreakdown(current => current === undefined ? undefined : normalizePerformanceBreakdownForRuntime(current, nextRegionAvailable));
    setOverview(performanceOverviewForDisplay(result.data));
    setScope(result.data.snapshot.scope);
    return normalization.changed ? committedQuery : true;
  }, [query, regionAvailable, performanceLoader]);

  const onQueryCommit = useCallback((previous: typeof query, next: typeof query) => {
    if (previous.groupBy !== next.groupBy) setHiddenSeries(new Set());
  }, []);
  const { loadedAt, loadedQuery, poll, refresh, refreshing } = useRefreshOnChange(
    query,
    loaderData.loadedAt,
    reload,
    setQuery,
    onQueryCommit,
  );

  const [editingRange, setEditingRange] = useState(false);
  useTelemetryPolling(poll, loadedQuery.range, !editingRange && !refreshing);

  const rankingDimension = pendingBreakdown ?? breakdownGroup;
  const needsRanking = overview !== null && regionAvailable !== null
    && (rankingDimension !== loadedQuery.groupBy || pendingBreakdown !== undefined);
  const scopeKey = scope === undefined ? undefined : JSON.stringify(scope);
  const rankingReload = useCallback(async (signal: AbortSignal) => {
    if (rankingDimension === loadedQuery.groupBy) {
      setBreakdownGroup(rankingDimension);
      setPendingBreakdown(undefined);
      return;
    }
    const requestedAt = pageWindow.current?.query === loadedQuery ? pageWindow.current.requestedAt : loadedAt;
    const read = { dimension: rankingDimension, query: loadedQuery, requestedAt, scopeKey };
    const result = await performanceLoader.load(loadedQuery, rankingDimension, requestedAt, scopeKey);
    if (signal.aborted) return;
    if (result.error) {
      setRankingFailure({ ...read, error: result.error });
    } else {
      if (performanceLoader.get(loadedQuery, rankingDimension, requestedAt, scopeKey) === undefined) return;
      setRanking(read);
      setRankingFailure(current => current?.dimension === rankingDimension ? undefined : current);
      setBreakdownGroup(rankingDimension);
    }
    setPendingBreakdown(undefined);
  }, [performanceLoader, loadedQuery, rankingDimension, loadedAt, scopeKey]);
  const {
    cancel: cancelRanking, refresh: refreshRanking, refreshInBackground: refreshRankingInBackground,
    backgroundRefreshing: rankingPolling, refreshing: rankingRefreshing,
  } = useRefresh(rankingReload);
  useEffect(() => {
    if (needsRanking) void refreshRankingInBackground();
    return cancelRanking;
  }, [needsRanking, refreshRankingInBackground, cancelRanking]);

  const urlState = useMemo<PerformanceUrlState>(
    () => ({ ...loadedQuery, metric, percentile, breakdown: breakdownGroup, sort, hidden: [...hiddenSeries] }),
    [breakdownGroup, hiddenSeries, loadedQuery, metric, percentile, sort],
  );

  useEffect(() => {
    setSearchParams(serializePerformanceUrlState(urlState), rewrite);
  }, [rewrite, setSearchParams, urlState]);

  // The page keeps the view in state and writes the URL after it, so each
  // choice carries the address its own view would be read at.
  const addressOf = (patch: Partial<PerformanceUrlState>) => `?${serializePerformanceUrlState({ ...urlState, ...patch })}`;

  // Fluent's single-select reports a click on the already-selected option too;
  // a fresh filters object for it would refetch and move the chart's bucket
  // axis under an operator who chose nothing.
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-combobox/library/src/utils/useSelection.ts#L23-L26
  const changeGroupBy = (next: PerformanceGroupBy) => {
    if (next === query.groupBy) return;
    setQuery(current => ({
      ...current,
      ...changeTelemetryGroupBy(current, next, identityContext),
    }));
  };
  const changeRange = (next: PerformanceRange) => {
    if (sameDashboardRange(next, query.range)) {
      void refresh();
      return;
    }
    setQuery(current => ({ ...current, range: next }));
  };
  const setFilter = (key: keyof PerformanceFilters, value: string[]) => setQuery(current => ({
    ...current,
    ...changeTelemetryFilter(current, key, value, identityContext),
  }));
  const buckets = useMemo(() => dashboardChartBuckets(loadedQuery.range, loadedAt), [loadedAt, loadedQuery.range]);
  const labels = useMemo(() => overview && performanceLabels(overview, overview.upstreams), [overview]);
  const chart = useMemo(() => overview && labels && buildPerformanceChart(overview.series, metric, percentile, loadedQuery.groupBy, labels, buckets, loadedQuery.range), [buckets, labels, loadedQuery.groupBy, loadedQuery.range, metric, overview, percentile]);

  const changeBreakdown = (key: PerformanceGroupBy) => {
    if (key === rankingDimension) return;
    cancelRanking();
    setRankingFailure(undefined);
    if (key === breakdownGroup || key === loadedQuery.groupBy) {
      setPendingBreakdown(undefined);
      setBreakdownGroup(key);
    } else {
      setPendingBreakdown(key);
    }
  };
  const activeRanking = ranking?.dimension === breakdownGroup && ranking.query === loadedQuery && ranking.scopeKey === scopeKey
    ? ranking : undefined;
  const rankingWindow = Math.max(loadedAt, activeRanking?.requestedAt ?? loadedAt);
  const showRanking = breakdownGroup !== loadedQuery.groupBy;
  const rankingDataset = showRanking ? performanceLoader.get(loadedQuery, breakdownGroup, rankingWindow, scopeKey) : undefined;
  const rankingRows = useMemo(() => rankingDataset === undefined ? undefined : performanceRanking(rankingDataset), [rankingDataset]);
  const tableRows = showRanking ? rankingRows : overview?.rows;
  const rankingError = rankingFailure?.query === loadedQuery && rankingFailure.scopeKey === scopeKey ? rankingFailure : undefined;
  const rankingBusy = pendingBreakdown !== undefined
    || (needsRanking && (rankingPolling || rankingRefreshing || (tableRows === undefined && rankingError === undefined)));
  const summary = overview?.summary;
  const summaryCards = [
    ['requests', formatCount(summary?.requests ?? 0, locale)],
    ['errors', formatCount(summary?.errors ?? 0, locale)],
    ['ttftP50', formatDuration(summary?.ttftMsP50 ?? null, locale)],
    ['speedP50', formatTokenRateFromTpot(summary?.tpotUsP50 ?? null)],
    ['ttftP95', formatDuration(summary?.ttftMsP95 ?? null, locale)],
    ['speedP95', formatTokenRateFromTpot(summary?.tpotUsP95 ?? null)],
    ['ttftP99', formatDuration(summary?.ttftMsP99 ?? null, locale)],
    ['speedP99', formatTokenRateFromTpot(summary?.tpotUsP99 ?? null)],
  ] as const;
  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions appearance="subtle" onRefresh={() => void refresh()} refreshLabel={t('monitoring.performance.actions.refresh')} refreshing={refreshing} />}
      description={t('monitoring.performance.description')}
      title={t('monitoring.performance.title')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}
    {(() => {
      if (overview === null || chart === null || labels === null || regionAvailable === null) return <Panel><EmptyStateLine>{t('common.errors.viewUnavailable')}</EmptyStateLine></Panel>;
      const dimensions: Array<TelemetryDimension<PerformanceGroupBy>> = [
        { key: 'model', groupLabel: t('monitoring.performance.groupBy.model'), filterLabel: t('monitoring.performance.filters.model'), allLabel: t('monitoring.performance.filters.all.model'), options: overview.dimensionValues.models.map(value => ({ value, label: value })) },
        { key: 'upstream', groupLabel: t('monitoring.performance.groupBy.upstream'), filterLabel: t('monitoring.performance.filters.upstream'), allLabel: t('monitoring.performance.filters.all.upstream'), options: overview.dimensionValues.upstreams.map(value => ({ value, label: labels.upstreams.get(value) ?? value })) },
        { key: 'operation', groupLabel: t('monitoring.performance.groupBy.operation'), filterLabel: t('monitoring.performance.filters.operation'), allLabel: t('monitoring.performance.filters.all.operation'), options: overview.dimensionValues.operations.map(value => ({ value, label: value })) },
        { key: 'runtimeLocation', groupLabel: t('monitoring.performance.groupBy.runtimeLocation'), filterLabel: t('monitoring.performance.filters.runtimeLocation'), allLabel: t('monitoring.performance.filters.all.runtimeLocation'), options: overview.dimensionValues.runtimeLocations.map(value => ({ value, label: value })) },
        {
          key: 'userId',
          groupLabel: t('monitoring.performance.groupBy.userId'),
          filterLabel: t('monitoring.performance.filters.userId'),
          allLabel: t('monitoring.performance.filters.all.userId'),
          options: [...new Set([...overview.users.map(user => String(user.id)), ...overview.dimensionValues.userIds.map(String)])]
            .map(value => ({ value, label: labels.users.get(value) ?? `user ${value}` })),
          selectionLabel: values => values.length === 1 && values[0] === loaderData.currentUserId
            ? t('monitoring.controls.currentUserOnly')
            : t('monitoring.performance.filters.selected', { count: values.length }),
        },
        { key: 'keyId', groupLabel: t('monitoring.performance.groupBy.keyId'), filterLabel: t('monitoring.performance.filters.keyId'), allLabel: t('monitoring.performance.filters.all.keyId'), options: overview.dimensionValues.keyIds.map(value => ({ value, label: labels.keys.get(value) ?? value })) },
      ];
      const availableDimensions = dimensions.filter(dimension => (
        (dimension.key !== 'runtimeLocation' || regionAvailable)
      ));
      const activeBreakdown = availableDimensions.find(item => item.key === breakdownGroup) ?? availableDimensions[0];
      if (activeBreakdown === undefined) throw new RangeError('Performance overview has no available breakdown dimension');
      return <>
        <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
          <div className="flex items-end gap-3 min-w-0 flex-wrap">
            <TelemetryGroupByField
              disabled={refreshing}
              dimensions={availableDimensions}
              groupBy={loadedQuery.groupBy}
              groupByAdornment={loadedQuery.groupBy === 'keyId' && <Tooltip content={t('monitoring.performance.apiKeyScopeInfo')} relationship="description">
                <Button
                  appearance="subtle"
                  aria-label={t('monitoring.performance.apiKeyScopeLabel')}
                  className={CONTROL_ROW_CLASS}
                  icon={<InfoRegular />}
                />
              </Tooltip>}
              groupByLabel={t('monitoring.performance.groupBy.label')}
              onGroupByChange={changeGroupBy}
            />
            <div className="ml-auto flex-none">
              <TelemetryTimeRange
                addressOf={range => addressOf({ range })}
                ariaLabel={t('monitoring.performance.range.label')}
                loadedAt={loadedAt}
                onChange={changeRange}
                onEditingChange={setEditingRange}
                range={loadedQuery.range}
              />
            </div>
          </div>
          <div className="flex items-end gap-3 min-w-0 flex-wrap">
            <TelemetryFilterFields
              disabled={refreshing}
              dimensions={availableDimensions}
              filters={loadedQuery.filters}
              groupBy={loadedQuery.groupBy}
              onFilterChange={setFilter}
              selectedLabel={count => t('monitoring.performance.filters.selected', { count })}
            />
          </div>
          <div className="grid gap-2.5 grid-cols-8 max-[1150px]:grid-cols-4 max-[620px]:grid-cols-2">
            {summaryCards.map(([label, value]) => <div className="grid gap-1 min-w-0 px-2 py-1" key={label}>
              <Text size={200} weight="semibold" className="text-fui-fg2">{t(`monitoring.performance.summary.${label}`)}</Text>
              <Text size={500} weight="semibold" className="tabular-nums [overflow-wrap:anywhere]">{value}</Text>
            </div>)}
          </div>
          <div className="flex items-end justify-between gap-4 min-w-0 flex-wrap">
            <ChoiceGroup ariaLabel={t('monitoring.performance.metric.label')} items={[
              { value: 'ttft', label: t('monitoring.performance.metric.ttft'), to: addressOf({ metric: 'ttft' }) },
              { value: 'tokPerSec', label: t('monitoring.performance.metric.outputSpeed'), to: addressOf({ metric: 'tokPerSec' }) },
            ]} onChange={value => setMetric(value as PerformanceMetric)} value={metric} />
            <div className="ml-auto flex-none">
              <ChoiceGroup ariaLabel={t('monitoring.performance.percentile.label')} items={performancePercentiles.map(value => ({ value, label: value, to: addressOf({ percentile: value }) }))} onChange={value => setPercentile(value as PerformancePercentile)} value={percentile} />
            </div>
          </div>
        </Panel>
        <Panel className="min-w-0">
          <PerformanceChartSection chart={chart} hidden={hiddenSeries} onHiddenChange={setHiddenSeries} title={t('monitoring.performance.chartTitle', { metric: metric === 'ttft' ? t('monitoring.performance.tables.ttft', { percentile }) : t('monitoring.performance.tables.speed', { tail: performancePercentileTailOf(percentile) }), group: t(`monitoring.performance.groupBy.${loadedQuery.groupBy}`) })} />
        </Panel>
        <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
          {/* The scrollport clips the 2px ring a focused tab paints, so it takes
            a gutter and the host removes the same distance again to keep the
            row aligned. An inward ring would land on the tab's selection pipe. */}
          <div className="flex items-center gap-2 min-w-0" aria-busy={rankingBusy}>
            <ScrollArea axes="horizontal" className="min-w-0 flex-1 -m-0.5" viewportClassName="p-0.5"><TabList aria-label={t('monitoring.performance.breakdown')} selectTabOnFocus={false} selectedValue={activeBreakdown.key} onTabSelect={(_, data) => changeBreakdown(data.value as PerformanceGroupBy)}>
              {availableDimensions.map(({ key }) => <Tab key={key} value={key}>{t(`monitoring.performance.groupBy.${key}`)}</Tab>)}
            </TabList></ScrollArea>
            {rankingBusy && <Spinner size="tiny" className="flex-none" aria-label={t('monitoring.performance.actions.refreshBreakdown')} />}
          </div>
          {rankingError !== undefined && <OutcomeMessageBar action={<Button size="small" appearance="subtle" onClick={() => {
            if (rankingError.dimension === breakdownGroup) void refreshRanking();
            else changeBreakdown(rankingError.dimension);
          }}>{t('monitoring.performance.actions.retryBreakdown')}</Button>}>
            {rankingError.error.message}
          </OutcomeMessageBar>}
          {tableRows !== undefined && <PerformanceTable groupBy={activeBreakdown.key}
            labels={rankingDataset === undefined ? labels : performanceLabels({
              users: [...overview.users, ...rankingDataset.snapshot.users],
              keys: rankingDataset.snapshot.keys,
            }, [...overview.upstreams, ...rankingDataset.snapshot.upstreams])}
            onSortChange={setSort} percentile={percentile} rows={tableRows} sort={sort} />}
        </Panel>
      </>;
    })()}
  </section>;
}
