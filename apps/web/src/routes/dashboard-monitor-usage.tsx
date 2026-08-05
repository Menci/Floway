import { InfoRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-monitor-usage';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import type { GlobalError } from '../api/client';
import { SEARCH_PROVIDER_LABEL_KEYS } from '../components/search/provider';
import { TelemetryDimensionControls, type TelemetryDimension } from '../components/telemetry/dimension-controls';
import { scopeTelemetryIdentity } from '../components/telemetry/filter-state';
import { ChoiceGroup } from '../components/ui/choice-group';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { CONTROL_ROW_CLASS, PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefreshOnChange } from '../components/ui/use-refresh';
import { UsageChartSection } from '../components/usage/chart-section';
import { loadUsagePageData } from '../components/usage/data';
import { clearGroupedUsageFilter, upstreamFromUsageValue, usageUpstreamValue } from '../components/usage/dimensions';
import { formatMetricValue } from '../components/usage/format';
import { buildSearchChart, buildTokenChart, dashboardBuckets, summarizeUsage } from '../components/usage/plot';
import { SummaryMetrics } from '../components/usage/summary-metrics';
import type { UsageFilters, UsageGroupBy, UsageMetric, UsageRange } from '../components/usage/types';
import { parseUsageUrlState, serializeUsageUrlState, type UsageUrlState } from '../components/usage/url-state';
import { formatCount } from '../lib/format-number';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';
import { fluentComponents } from '../fluent';

const { Button, Tooltip } = fluentComponents;

type LoaderData = Awaited<ReturnType<typeof loadUsagePageData>> & {
  isAdmin: boolean;
  loadedAt: number;
  state: UsageUrlState;
};

const requiredLabel = (labels: ReadonlyMap<string, string>, value: string, dimension: string) => {
  const label = labels.get(value);
  if (label === undefined) throw new TypeError(`Usage ${dimension} dimension is missing metadata for ${value}`);
  return label;
};

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  const user = await requireDashboardUser();
  const parsed = parseUsageUrlState(new URL(request.url).searchParams);
  const scoped = scopeTelemetryIdentity(parsed.groupBy, parsed.filters, user.isAdmin, 'model');
  const loadedAt = Date.now();
  return {
    ...await loadUsagePageData(user.isAdmin, parsed.range, scoped.groupBy, scoped.filters, loadedAt),
    isAdmin: user.isAdmin,
    loadedAt,
    state: { ...parsed, ...scoped },
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardMonitorUsage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  const initialState = loaderData.state;
  const [range, setRange] = useState<UsageRange>(initialState.range);
  const [loadedRange, setLoadedRange] = useState<UsageRange>(initialState.range);
  const [loadedAt, setLoadedAt] = useState(loaderData.loadedAt);
  const [usage, setUsage] = useState(loaderData.usage);
  const [search, setSearch] = useState(loaderData.search);
  const [upstreams, setUpstreams] = useState(loaderData.upstreams);
  const [metric, setMetric] = useState<UsageMetric>(initialState.metric);
  const [groupBy, setGroupBy] = useState<UsageGroupBy>(initialState.groupBy);
  const [filters, setFilters] = useState<UsageFilters>(initialState.filters);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(initialState.hidden));
  const [hiddenSearch, setHiddenSearch] = useState<Set<string>>(() => new Set(initialState.hiddenSearch));
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const query = useMemo(() => ({ filters, groupBy, range }), [filters, groupBy, range]);
  const locale = useLocale();

  const reload = useCallback(async (signal: AbortSignal, { background }: { background: boolean }, arrived: () => void) => {
    const requestedAt = Date.now();
    if (!background) setError(null);
    const next = await loadUsagePageData(loaderData.isAdmin, query.range, query.groupBy, query.filters, requestedAt, signal);
    if (signal.aborted) return;
    setUsage(next.usage);
    setSearch(next.search);
    setUpstreams(next.upstreams);
    setLoadedRange(query.range);
    setLoadedAt(requestedAt);
    arrived();
    setError(next.error);
  }, [loaderData.isAdmin, query]);

  const { poll, refresh, refreshing } = useRefreshOnChange(query, reload);
  usePollWhileVisible(poll);

  const urlState = useMemo<UsageUrlState>(
    () => ({ range, groupBy, filters, metric, hidden: [...hiddenSeries], hiddenSearch: [...hiddenSearch] }),
    [filters, groupBy, hiddenSearch, hiddenSeries, metric, range],
  );
  useEffect(() => {
    setSearchParams(serializeUsageUrlState(urlState), rewrite);
  }, [rewrite, setSearchParams, urlState]);
  const addressOf = (patch: Partial<UsageUrlState>) => `?${serializeUsageUrlState({ ...urlState, ...patch })}`;

  const buckets = useMemo(() => dashboardBuckets(loadedRange, loadedAt, locale), [loadedAt, loadedRange, locale]);
  const dimensions = useMemo<Array<TelemetryDimension<UsageGroupBy>> | null>(() => {
    if (!usage) return null;
    const upstreamNames = new Map(upstreams.map(upstream => [usageUpstreamValue(upstream.id), upstream.name]));
    const noUpstreamLabel = t('dashboard.usage.filters.noUpstream');
    for (const value of usage.dimensionValues.upstreams) {
      if (!upstreamNames.has(value)) upstreamNames.set(value, upstreamFromUsageValue(value) ?? noUpstreamLabel);
    }
    const users = new Map(usage.users.map(user => [String(user.id), user.username]));
    const keys = new Map(usage.keys.map(key => [key.id, key.name]));
    return [
      { key: 'model', groupLabel: t('dashboard.usage.groupBy.model'), filterLabel: t('dashboard.usage.filters.model'), allLabel: t('dashboard.usage.filters.all.model'), options: usage.dimensionValues.models.map(value => ({ value, label: value })) },
      { key: 'upstream', groupLabel: t('dashboard.usage.groupBy.upstream'), filterLabel: t('dashboard.usage.filters.upstream'), allLabel: t('dashboard.usage.filters.all.upstream'), options: usage.dimensionValues.upstreams.map(value => ({ value, label: upstreamNames.get(value) ?? value })) },
      { key: 'userId', groupLabel: t('dashboard.usage.groupBy.userId'), filterLabel: t('dashboard.usage.filters.userId'), allLabel: t('dashboard.usage.filters.all.userId'), options: usage.dimensionValues.userIds.map(value => ({ value: String(value), label: requiredLabel(users, String(value), 'user') })) },
      { key: 'keyId', groupLabel: t('dashboard.usage.groupBy.keyId'), filterLabel: t('dashboard.usage.filters.keyId'), allLabel: t('dashboard.usage.filters.all.keyId'), options: usage.dimensionValues.keyIds.map(value => ({ value, label: requiredLabel(keys, value, 'API key') })) },
    ];
  }, [t, upstreams, usage]);
  const availableDimensions = dimensions?.filter(dimension => dimension.key !== 'userId' || loaderData.isAdmin) ?? null;
  const filterDimensions = availableDimensions?.filter(dimension => (
    !((dimension.key === 'userId' || dimension.key === 'keyId') && (groupBy === 'userId' || groupBy === 'keyId'))
  ));
  const selectedDimension = availableDimensions?.find(dimension => dimension.key === groupBy);
  const visibleSeries = useMemo(
    () => usage?.series.filter(record => !hiddenSeries.has(record.group)) ?? null,
    [hiddenSeries, usage],
  );
  const summary = useMemo(() => {
    if (!usage || !visibleSeries) return null;
    if (hiddenSeries.size === 0) return summarizeUsage(usage.axes.none);
    return summarizeUsage(visibleSeries);
  }, [hiddenSeries, usage, visibleSeries]);
  const tokenChart = useMemo(() => {
    if (!usage || !selectedDimension) return null;
    return buildTokenChart({
      records: usage.series,
      dimensionOptions: selectedDimension.options,
      metric,
      range: loadedRange,
      buckets,
    });
  }, [buckets, loadedRange, metric, selectedDimension, usage]);
  const searchChart = useMemo(
    () => search && buildSearchChart({ search, range: loadedRange, buckets }),
    [buckets, loadedRange, search],
  );
  const showSearch = searchChart === null || searchChart.entries.length > 0;

  const changeGroupBy = (next: UsageGroupBy) => {
    if (next === groupBy) return;
    setGroupBy(next);
    setFilters(current => clearGroupedUsageFilter(current, next));
    setHiddenSeries(new Set());
  };
  const setFilter = (key: UsageGroupBy, values: string[]) => setFilters(current => ({ ...current, [key]: values }));

  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions appearance="subtle" onRefresh={() => void refresh()} refreshLabel={t('dashboard.usage.actions.refresh')} refreshing={refreshing} />}
      description={t('dashboard.pages.usage')}
      title={t('dashboard.nav.usage')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}

    <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
      {availableDimensions && filterDimensions && <TelemetryDimensionControls
        dimensions={availableDimensions}
        filterDimensions={filterDimensions}
        filters={filters}
        groupBy={groupBy}
        groupByAdornment={groupBy === 'keyId' && <Tooltip content={t('dashboard.usage.apiKeyScopeInfo')} relationship="description">
          <Button
            appearance="subtle"
            aria-label={t('dashboard.usage.apiKeyScopeLabel')}
            className={CONTROL_ROW_CLASS}
            icon={<InfoRegular />}
          />
        </Tooltip>}
        groupByLabel={t('dashboard.usage.groupBy.label')}
        onFilterChange={setFilter}
        onGroupByChange={changeGroupBy}
        selectedLabel={count => t('dashboard.usage.filters.selected', { count })}
      />}
      <div className="flex justify-end min-w-0">
        <ChoiceGroup
          ariaLabel={t('dashboard.usage.range.label')}
          items={[
            { value: 'today', label: t('dashboard.usage.range.today'), to: addressOf({ range: 'today' }) },
            { value: '7d', label: t('dashboard.usage.range.sevenDays'), to: addressOf({ range: '7d' }) },
            { value: '30d', label: t('dashboard.usage.range.thirtyDays'), to: addressOf({ range: '30d' }) },
          ]}
          onChange={value => setRange(value as UsageRange)}
          value={range}
        />
      </div>

      {tokenChart === null || summary === null || selectedDimension === undefined ? (
        <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine>
      ) : <>
        <UsageChartSection
          chart={tokenChart}
          detailsLabel={selectedDimension.groupLabel}
          hidden={hiddenSeries}
          onHiddenChange={setHiddenSeries}
          title={selectedDimension.groupLabel}
          valueFormatter={value => formatMetricValue(value, metric, locale)}
        />
        <SummaryMetrics metric={metric} onMetricChange={setMetric} summary={summary} />
      </>}
    </Panel>

    {showSearch && <Panel className="min-w-0">
      {searchChart === null ? <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine> : (
        <UsageChartSection
          chart={searchChart}
          detailsLabel={t('dashboard.usage.charts.search')}
          hidden={hiddenSearch}
          onHiddenChange={setHiddenSearch}
          title={t('dashboard.usage.charts.searchWithProvider', {
            provider: searchChart.providers
              .map(id => SEARCH_PROVIDER_LABEL_KEYS[id] === undefined ? id : t(SEARCH_PROVIDER_LABEL_KEYS[id]))
              .join(', '),
          })}
          valueFormatter={value => formatCount(value, locale)}
        />
      )}
    </Panel>}
  </section>;
}
