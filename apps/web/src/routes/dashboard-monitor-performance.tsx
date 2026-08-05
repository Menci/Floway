import { InfoRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-monitor-performance';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi, type GlobalError } from '../api/client';
import { PerformanceChartSection } from '../components/performance/chart';
import { loadPerformancePageData, type PerformancePageData } from '../components/performance/data';
import {
  buildPerformanceQuery,
  performanceLabels,
  serializePerformanceUrlState,
  type PerformanceFilters,
  type PerformanceGroupBy,
  type PerformanceMetric,
  type PerformanceOverviewResponse,
  type PerformancePercentile,
  type PerformanceRange,
  type PerformanceUrlState,
  type PerformanceView,
} from '../components/performance/overview';
import { buildPerformanceChart, performanceBuckets } from '../components/performance/plot';
import { PerformanceTable } from '../components/performance/table';
import { TelemetryDimensionControls, type TelemetryDimension } from '../components/telemetry/dimension-controls';
import { changeTelemetryFilter, changeTelemetryGroupBy } from '../components/telemetry/filter-state';
import { ChoiceGroup } from '../components/ui/choice-group';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { CONTROL_ROW_CLASS, PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefreshOnChange } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { formatDuration } from '../lib/format-duration';
import { formatCount, formatTokenRateFromTpot } from '../lib/format-number';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';

const { Button, Tab, TabList, Text, Tooltip } = fluentComponents;

const groupByValues: PerformanceGroupBy[] = ['model', 'upstream', 'operation', 'runtimeLocation', 'keyId', 'userId'];

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<PerformancePageData> {
  const user = await requireDashboardUser();
  return await loadPerformancePageData(request, user);
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardMonitorPerformance({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  const initialState = loaderData.state;
  const view: PerformanceView = loaderData.view;
  const [query, setQuery] = useState(() => ({
    filters: initialState.filters,
    groupBy: initialState.groupBy === 'userId' && view !== 'all-by-user' ? 'model' as const : initialState.groupBy,
    range: initialState.range,
  }));
  const [metric, setMetric] = useState<PerformanceMetric>(initialState.metric);
  const [percentile, setPercentile] = useState<PerformancePercentile>(initialState.percentile);
  const [breakdownGroup, setBreakdownGroup] = useState<PerformanceGroupBy>('model');
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(initialState.hidden));
  const [overview, setOverview] = useState<PerformanceOverviewResponse | null>(loaderData.overview);
  const [upstreamNames] = useState(() => loaderData.upstreamNames && new Map(loaderData.upstreamNames.map(record => [record.id, record.name])));
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const locale = useLocale();
  const identityContext = {
    currentUserId: loaderData.currentUserId,
    fallbackGroup: 'model' as const,
    userDimensionAvailable: view === 'all-by-user',
  };

  // A background poll must not clear a failure the operator has not read.
  const reload = useCallback(async (signal: AbortSignal, { background, requestedAt }: { background: boolean; requestedAt: number }) => {
    if (!background) setError(null);
    const search = buildPerformanceQuery(query.range, query.groupBy, query.filters, requestedAt);
    const result = await callApi(() => api.api.performance.overview.$get(
      { query: search },
      { init: { signal } },
    ));
    if (signal.aborted) return false;
    if (result.error) {
      setError(result.error);
      return false;
    }
    setOverview(result.data);
    return true;
  }, [query]);

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

  usePollWhileVisible(poll);

  const urlState = useMemo<PerformanceUrlState>(
    () => ({ ...loadedQuery, metric, percentile, hidden: [...hiddenSeries] }),
    [hiddenSeries, loadedQuery, metric, percentile],
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
    if (next === query.range) return;
    setQuery(current => ({ ...current, range: next }));
  };
  const setFilter = (key: keyof PerformanceFilters, value: string[]) => setQuery(current => ({
    ...current,
    ...changeTelemetryFilter(current, key, value, identityContext),
  }));
  const buckets = useMemo(() => performanceBuckets(loadedQuery.range, loadedAt, locale), [loadedAt, loadedQuery.range, locale]);
  const labels = useMemo(() => overview && upstreamNames && performanceLabels(overview, upstreamNames), [overview, upstreamNames]);
  const chart = useMemo(() => overview && labels && buildPerformanceChart(overview.series, metric, percentile, loadedQuery.groupBy, labels, buckets, loadedQuery.range), [buckets, labels, loadedQuery.groupBy, loadedQuery.range, metric, overview, percentile]);
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
  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions appearance="subtle" onRefresh={() => void refresh()} refreshLabel={t('dashboard.performance.actions.refresh')} refreshing={refreshing} />}
      description={t('dashboard.pages.performance')}
      title={t('dashboard.nav.performance')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}
    {(() => {
      if (overview === null || chart === null || labels === null) return <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel>;
      const breakdowns = groupByValues
        .filter(key => key !== 'userId' || view === 'all-by-user')
        .map(key => ({ key, rows: overview.axes[key] }));
      const activeBreakdown = breakdowns.find(item => item.key === breakdownGroup) ?? breakdowns[0];
      if (activeBreakdown === undefined) throw new RangeError('Performance overview has no available breakdown dimension');
      const dimensions: Array<TelemetryDimension<PerformanceGroupBy>> = [
        { key: 'model', groupLabel: t('dashboard.performance.groupBy.model'), filterLabel: t('dashboard.performance.filters.model'), allLabel: t('dashboard.performance.filters.all.model'), options: overview.dimensionValues.models.map(value => ({ value, label: value })) },
        { key: 'upstream', groupLabel: t('dashboard.performance.groupBy.upstream'), filterLabel: t('dashboard.performance.filters.upstream'), allLabel: t('dashboard.performance.filters.all.upstream'), options: overview.dimensionValues.upstreams.map(value => ({ value, label: labels.upstreams.get(value) ?? value })) },
        { key: 'operation', groupLabel: t('dashboard.performance.groupBy.operation'), filterLabel: t('dashboard.performance.filters.operation'), allLabel: t('dashboard.performance.filters.all.operation'), options: overview.dimensionValues.operations.map(value => ({ value, label: value })) },
        { key: 'runtimeLocation', groupLabel: t('dashboard.performance.groupBy.runtimeLocation'), filterLabel: t('dashboard.performance.filters.runtimeLocation'), allLabel: t('dashboard.performance.filters.all.runtimeLocation'), options: overview.dimensionValues.runtimeLocations.map(value => ({ value, label: value })) },
        {
          key: 'userId',
          groupLabel: t('dashboard.performance.groupBy.userId'),
          filterLabel: t('dashboard.performance.filters.userId'),
          allLabel: t('dashboard.performance.filters.all.userId'),
          options: [...new Set([...overview.dimensionValues.userIds.map(String), ...loadedQuery.filters.userId])]
            .map(value => ({ value, label: labels.users.get(value) ?? `user ${value}` })),
          selectionLabel: values => values.length === 1 && values[0] === loaderData.currentUserId
            ? t('dashboard.telemetry.currentUserOnly')
            : t('dashboard.performance.filters.selected', { count: values.length }),
        },
        { key: 'keyId', groupLabel: t('dashboard.performance.groupBy.keyId'), filterLabel: t('dashboard.performance.filters.keyId'), allLabel: t('dashboard.performance.filters.all.keyId'), options: overview.dimensionValues.keyIds.map(value => ({ value, label: labels.keys.get(value) ?? value })) },
      ];
      const availableDimensions = dimensions.filter(dimension => dimension.key !== 'userId' || view === 'all-by-user');
      return <>
        <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
          <TelemetryDimensionControls
            disabled={refreshing}
            dimensions={availableDimensions}
            filters={loadedQuery.filters}
            groupBy={loadedQuery.groupBy}
            groupByAdornment={loadedQuery.groupBy === 'keyId' && <Tooltip content={t('dashboard.performance.apiKeyScopeInfo')} relationship="description">
              <Button
                appearance="subtle"
                aria-label={t('dashboard.performance.apiKeyScopeLabel')}
                className={CONTROL_ROW_CLASS}
                icon={<InfoRegular />}
              />
            </Tooltip>}
            groupByLabel={t('dashboard.performance.groupBy.label')}
            onFilterChange={setFilter}
            onGroupByChange={changeGroupBy}
            selectedLabel={count => t('dashboard.performance.filters.selected', { count })}
          />
          <div className="grid gap-2.5 grid-cols-8 max-[1150px]:grid-cols-4 max-[620px]:grid-cols-2">
            {summaryCards.map(([label, value]) => <div className="grid gap-1 min-w-0 px-2 py-1" key={label}>
              <Text size={200} weight="semibold" className="text-fui-fg2">{t(`dashboard.performance.summary.${label}`)}</Text>
              <Text size={500} weight="semibold" className="tabular-nums [overflow-wrap:anywhere]">{value}</Text>
            </div>)}
          </div>
          <div className="flex items-center justify-between gap-4 min-w-0 flex-wrap">
            <ChoiceGroup ariaLabel={t('dashboard.performance.metric.label')} items={[
              { value: 'ttft', label: t('dashboard.performance.metric.ttft'), to: addressOf({ metric: 'ttft' }) },
              { value: 'tokPerSec', label: t('dashboard.performance.metric.outputSpeed'), to: addressOf({ metric: 'tokPerSec' }) },
            ]} onChange={value => setMetric(value as PerformanceMetric)} value={metric} />
            <ChoiceGroup ariaLabel={t('dashboard.performance.percentile.label')} items={(['p50', 'p95', 'p99'] as const).map(value => ({ value, label: value, to: addressOf({ percentile: value }) }))} onChange={value => setPercentile(value as PerformancePercentile)} value={percentile} />
            <ChoiceGroup ariaLabel={t('dashboard.performance.range.label')} disabled={refreshing} items={[
              { value: 'today', label: t('dashboard.performance.range.today'), to: addressOf({ range: 'today' }) }, { value: '7d', label: t('dashboard.performance.range.sevenDays'), to: addressOf({ range: '7d' }) }, { value: '30d', label: t('dashboard.performance.range.thirtyDays'), to: addressOf({ range: '30d' }) },
            ]} onChange={value => changeRange(value as PerformanceRange)} value={loadedQuery.range} />
          </div>
        </Panel>
        <Panel className="min-w-0">
          <PerformanceChartSection chart={chart} hidden={hiddenSeries} onHiddenChange={setHiddenSeries} title={t('dashboard.performance.chartTitle', { metric: t(`dashboard.performance.metric.${metric === 'ttft' ? 'ttft' : 'outputSpeed'}`), group: t(`dashboard.performance.groupBy.${loadedQuery.groupBy}`), percentile })} />
        </Panel>
        <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
          {/* The scrollport clips the 2px ring a focused tab paints, so it takes
            a gutter and the host removes the same distance again to keep the
            row aligned. An inward ring would land on the tab's selection pipe. */}
          <ScrollArea axes="horizontal" className="min-w-0 -m-0.5" viewportClassName="p-0.5"><TabList aria-label={t('dashboard.performance.breakdown')} selectedValue={activeBreakdown.key} onTabSelect={(_, data) => setBreakdownGroup(data.value as PerformanceGroupBy)}>
            {breakdowns.map(({ key }) => <Tab key={key} value={key}>{t(`dashboard.performance.groupBy.${key}`)}</Tab>)}
          </TabList></ScrollArea>
          <PerformanceTable groupBy={activeBreakdown.key} labels={labels} rows={activeBreakdown.rows} />
        </Panel>
      </>;
    })()}
  </section>;
}
