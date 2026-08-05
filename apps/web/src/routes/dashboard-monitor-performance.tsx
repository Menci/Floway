import { InfoRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-monitor-performance';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi, type GlobalError } from '../api/client';
import { PerformanceChartSection } from '../components/performance/chart';
import {
  buildPerformanceQuery,
  clearGroupedFilter,
  parsePerformanceUrlState,
  performanceLabels,
  serializePerformanceUrlState,
  type PerformanceFilters,
  type PerformanceGroupBy,
  type PerformanceLabels,
  type PerformanceMetric,
  type PerformanceOverviewResponse,
  type PerformancePercentile,
  type PerformanceRange,
  type PerformanceUrlState,
  type PerformanceView,
} from '../components/performance/overview';
import { buildPerformanceChart, performanceBuckets } from '../components/performance/plot';
import { PerformanceTable } from '../components/performance/table';
import { ChoiceGroup } from '../components/ui/choice-group';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Dropdown } from '../components/ui/fluent-form-controls';
import { CONTROL_ROW_CLASS, PANEL_STACK_CLASS } from '../components/ui/layout';
import { MultiselectCombobox } from '../components/ui/multiselect-combobox';
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

const { Button, Field, Option, Tab, TabList, Text, Tooltip } = fluentComponents;

interface UpstreamName { id: string; name: string }

const groupByValues: PerformanceGroupBy[] = ['model', 'upstream', 'operation', 'runtimeLocation', 'keyId', 'userId'];

interface LoaderData {
  error: GlobalError | null;
  loadedAt: number;
  // `null` is a failed fetch, not a quiet gateway: an empty overview would
  // render zeroes the page does not know to be true.
  overview: PerformanceOverviewResponse | null;
  state: PerformanceUrlState;
  // Null on the same terms: without the names, a group labels itself with an
  // upstream id the page would be presenting as a name.
  upstreamNames: UpstreamName[] | null;
  view: PerformanceView;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  const user = await requireDashboardUser();
  const state = parsePerformanceUrlState(new URL(request.url).searchParams);
  const view: PerformanceView = user.isAdmin ? 'all-by-user' : 'self-by-key';
  const groupBy = state.groupBy === 'userId' && view !== 'all-by-user' ? 'model' : state.groupBy;
  const loadedAt = Date.now();
  const query = buildPerformanceQuery(state.range, groupBy, state.filters, loadedAt);
  // The page opens for every signed-in account, so the names come from the
  // non-admin upstream picker; /api/upstreams answers 403 to an operator and
  // would leave the whole page unavailable to them.
  const [overview, upstreams] = await Promise.all([
    callApi(() => api.api.performance.overview.$get({ query })),
    callApi(() => api.api['upstream-options'].$get()),
  ]);
  return {
    error: overview.error ?? upstreams.error ?? null,
    loadedAt,
    overview: overview.data ?? null,
    state: { ...state, groupBy },
    upstreamNames: upstreams.data?.map(({ id, name }) => ({ id, name })) ?? null,
    view,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardMonitorPerformance({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const rewrite = useEntryRewrite();
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
  const [upstreamNames] = useState(() => loaderData.upstreamNames && new Map(loaderData.upstreamNames.map(record => [record.id, record.name])));
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const query = useMemo(() => ({ filters, groupBy, range }), [filters, groupBy, range]);
  const locale = useLocale();

  // A background poll must not clear a failure the operator has not read.
  const reload = useCallback(async (signal: AbortSignal, { background }: { background: boolean }, arrived: () => void) => {
    const requestedAt = Date.now();
    if (!background) setError(null);
    const search = buildPerformanceQuery(query.range, query.groupBy, query.filters, requestedAt);
    const result = await callApi(() => api.api.performance.overview.$get(
      { query: search },
      { init: { signal } },
    ));
    if (signal.aborted) return;
    if (result.error) setError(result.error);
    else {
      setOverview(result.data);
      setLoadedRange(query.range);
      setLoadedAt(requestedAt);
      arrived();
    }
  }, [query]);

  const { poll, refresh, refreshing } = useRefreshOnChange(query, reload);

  usePollWhileVisible(poll);

  const urlState = useMemo<PerformanceUrlState>(
    () => ({ metric, percentile, groupBy, range, filters, hidden: [...hiddenSeries] }),
    [filters, groupBy, hiddenSeries, metric, percentile, range],
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
    if (next === groupBy) return;
    setGroupBy(next);
    setFilters(current => clearGroupedFilter(current, next));
    setHiddenSeries(new Set());
  };
  const setFilter = (key: keyof PerformanceFilters, value: string[]) => setFilters(current => ({ ...current, [key]: value }));
  const buckets = useMemo(() => performanceBuckets(loadedRange, loadedAt, locale), [loadedAt, loadedRange, locale]);
  const labels = useMemo(() => overview && upstreamNames && performanceLabels(overview, upstreamNames), [overview, upstreamNames]);
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
      actions={<ResourceListActions appearance="subtle" onRefresh={() => void refresh()} refreshLabel={t('dashboard.performance.actions.refresh')} refreshing={refreshing} />}
      description={t('dashboard.pages.performance')}
      title={t('dashboard.nav.performance')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}
    {overview === null || chart === null || labels === null || activeBreakdown === undefined ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
      <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
        <div className="flex items-end gap-3 min-w-0 flex-wrap">
          <Field className="w-[160px] flex-none" label={t('dashboard.performance.groupBy.label')}>
            <div className="flex items-center gap-2">
              <Dropdown
                className="flex-1"
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
                    className={CONTROL_ROW_CLASS}
                    icon={<InfoRegular />}
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
            <Text size={500} weight="semibold" className="tabular-nums [overflow-wrap:anywhere]">{value}</Text>
          </div>)}
        </div>
        <div className="flex items-center justify-between gap-4 min-w-0 flex-wrap">
          <ChoiceGroup ariaLabel={t('dashboard.performance.metric.label')} items={[
            { value: 'ttft', label: t('dashboard.performance.metric.ttft'), to: addressOf({ metric: 'ttft' }) },
            { value: 'tokPerSec', label: t('dashboard.performance.metric.outputSpeed'), to: addressOf({ metric: 'tokPerSec' }) },
          ]} onChange={value => setMetric(value as PerformanceMetric)} value={metric} />
          <ChoiceGroup ariaLabel={t('dashboard.performance.percentile.label')} items={(['p50', 'p95', 'p99'] as const).map(value => ({ value, label: value, to: addressOf({ percentile: value }) }))} onChange={value => setPercentile(value as PerformancePercentile)} value={percentile} />
          <ChoiceGroup ariaLabel={t('dashboard.performance.range.label')} items={[
            { value: 'today', label: t('dashboard.performance.range.today'), to: addressOf({ range: 'today' }) }, { value: '7d', label: t('dashboard.performance.range.sevenDays'), to: addressOf({ range: '7d' }) }, { value: '30d', label: t('dashboard.performance.range.thirtyDays'), to: addressOf({ range: '30d' }) },
          ]} onChange={value => setRange(value as PerformanceRange)} value={range} />
        </div>
      </Panel>
      <Panel className="min-w-0">
        <PerformanceChartSection chart={chart} hidden={hiddenSeries} onHiddenChange={setHiddenSeries} title={t('dashboard.performance.chartTitle', { metric: t(`dashboard.performance.metric.${metric === 'ttft' ? 'ttft' : 'outputSpeed'}`), group: t(`dashboard.performance.groupBy.${groupBy}`), percentile })} />
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
    </>}
  </section>;
}

function PerformanceFilterFields({ filters, groupBy, labels, onChange, overview, view }: {
  filters: PerformanceFilters; groupBy: PerformanceGroupBy; labels: PerformanceLabels;
  onChange: (key: keyof PerformanceFilters, value: string[]) => void;
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
      <MultiselectCombobox
        className="w-full"
        clearLabel={t(`dashboard.performance.filters.all.${key}`)}
        onChange={value => onChange(key, value)}
        options={values}
        placeholder={filters[key].length === 0
          ? t(`dashboard.performance.filters.all.${key}`)
          : t('dashboard.performance.filters.selected', { count: filters[key].length })}
        value={filters[key]}
      />
    </Field>)}
  </>;
}
