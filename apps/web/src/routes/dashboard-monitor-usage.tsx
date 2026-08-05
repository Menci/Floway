import { InfoRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-monitor-usage';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import type { GlobalError } from '../api/client';
import { SEARCH_PROVIDER_LABEL_KEYS } from '../components/search/provider';
import {
  TelemetryFilterFields,
  TelemetryGroupByField,
  type TelemetryDimension,
} from '../components/telemetry/dimension-controls';
import { changeTelemetryFilter, changeTelemetryGroupBy, scopeTelemetryIdentity } from '../components/telemetry/filter-state';
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
import { formatMetricValue } from '../components/usage/format';
import { buildSearchChart, buildTokenChart, dashboardBuckets, summarizeUsage } from '../components/usage/plot';
import { SummaryMetrics } from '../components/usage/summary-metrics';
import type { UsageGroupBy, UsageMetric, UsageRange } from '../components/usage/types';
import { parseUsageUrlState, serializeUsageUrlState, type UsageUrlState } from '../components/usage/url-state';
import { fluentComponents } from '../fluent';
import { formatCount } from '../lib/format-number';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';
import { tokenUsageUnattributedUserId, usageUpstreamDimensionValue, usageUpstreamFromDimensionValue } from '@floway-dev/protocols/common';

const { Button, Tooltip } = fluentComponents;

type LoaderData = Awaited<ReturnType<typeof loadUsagePageData>> & {
  currentUserId: string;
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
  const scoped = scopeTelemetryIdentity(parsed.groupBy, parsed.filters, {
    currentUserId: String(user.id),
    fallbackGroup: 'model',
    userDimensionAvailable: user.isAdmin,
  });
  const loadedAt = Date.now();
  return {
    ...await loadUsagePageData(user.isAdmin, parsed.range, scoped.groupBy, scoped.filters, loadedAt),
    currentUserId: String(user.id),
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
  const [query, setQuery] = useState(() => ({
    filters: initialState.filters,
    groupBy: initialState.groupBy,
    range: initialState.range,
  }));
  const [usage, setUsage] = useState(loaderData.usage);
  const [search, setSearch] = useState(loaderData.search);
  const [upstreams, setUpstreams] = useState(loaderData.upstreams);
  const [metric, setMetric] = useState<UsageMetric>(initialState.metric);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(initialState.hidden));
  const [hiddenSearch, setHiddenSearch] = useState<Set<string>>(() => new Set(initialState.hiddenSearch));
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const locale = useLocale();
  const identityContext = {
    currentUserId: loaderData.currentUserId,
    fallbackGroup: 'model' as const,
    userDimensionAvailable: loaderData.isAdmin,
  };

  const reload = useCallback(async (signal: AbortSignal, { background, requestedAt }: { background: boolean; requestedAt: number }) => {
    if (!background) setError(null);
    const next = await loadUsagePageData(loaderData.isAdmin, query.range, query.groupBy, query.filters, requestedAt, signal);
    if (signal.aborted) return false;
    if (next.usage === null) {
      setError(next.error);
      return false;
    }
    setUsage(next.usage);
    setSearch(next.search);
    setUpstreams(next.upstreams);
    setError(next.error);
    return true;
  }, [loaderData.isAdmin, query]);

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

  const urlState = useMemo<UsageUrlState>(
    () => ({ ...loadedQuery, metric, hidden: [...hiddenSeries], hiddenSearch: [...hiddenSearch] }),
    [hiddenSearch, hiddenSeries, loadedQuery, metric],
  );
  useEffect(() => {
    setSearchParams(serializeUsageUrlState(urlState), rewrite);
  }, [rewrite, setSearchParams, urlState]);
  const addressOf = (patch: Partial<UsageUrlState>) => `?${serializeUsageUrlState({ ...urlState, ...patch })}`;

  const buckets = useMemo(() => dashboardBuckets(loadedQuery.range, loadedAt, locale), [loadedAt, loadedQuery.range, locale]);
  const dimensions = useMemo<Array<TelemetryDimension<UsageGroupBy>> | null>(() => {
    if (!usage) return null;
    const upstreamNames = new Map(upstreams.map(upstream => [usageUpstreamDimensionValue(upstream.id), upstream.name]));
    const unknownUpstreamLabel = t('dashboard.usage.filters.unknownUpstream');
    for (const value of usage.dimensionValues.upstreams) {
      if (!upstreamNames.has(value)) upstreamNames.set(value, usageUpstreamFromDimensionValue(value) ?? unknownUpstreamLabel);
    }
    const users = new Map(usage.users.map(user => [String(user.id), user.username]));
    const keys = new Map(usage.keys.map(key => [key.id, key.name]));
    const userIds = usage.dimensionValues.userIds.map(String);
    if (loadedQuery.filters.userId.includes(loaderData.currentUserId) && !userIds.includes(loaderData.currentUserId)) {
      userIds.unshift(loaderData.currentUserId);
    }
    return [
      { key: 'model', groupLabel: t('dashboard.usage.groupBy.model'), filterLabel: t('dashboard.usage.filters.model'), allLabel: t('dashboard.usage.filters.all.model'), options: usage.dimensionValues.models.map(value => ({ value, label: value })) },
      { key: 'upstream', groupLabel: t('dashboard.usage.groupBy.upstream'), filterLabel: t('dashboard.usage.filters.upstream'), allLabel: t('dashboard.usage.filters.all.upstream'), options: usage.dimensionValues.upstreams.map(value => ({ value, label: requiredLabel(upstreamNames, value, 'upstream') })) },
      {
        key: 'userId',
        groupLabel: t('dashboard.usage.groupBy.userId'),
        filterLabel: t('dashboard.usage.filters.userId'),
        allLabel: t('dashboard.usage.filters.all.userId'),
        options: userIds.map(value => ({ value, label: Number(value) === tokenUsageUnattributedUserId ? t('dashboard.usage.filters.unknownUser') : requiredLabel(users, value, 'user') })),
        selectionLabel: values => values.length === 1 && values[0] === loaderData.currentUserId
          ? t('dashboard.telemetry.currentUserOnly')
          : t('dashboard.usage.filters.selected', { count: values.length }),
      },
      { key: 'keyId', groupLabel: t('dashboard.usage.groupBy.keyId'), filterLabel: t('dashboard.usage.filters.keyId'), allLabel: t('dashboard.usage.filters.all.keyId'), options: usage.dimensionValues.keyIds.map(value => ({ value, label: requiredLabel(keys, value, 'API key') })) },
    ];
  }, [loadedQuery.filters.userId, loaderData.currentUserId, t, upstreams, usage]);
  const availableDimensions = dimensions?.filter(dimension => dimension.key !== 'userId' || loaderData.isAdmin) ?? null;
  const selectedDimension = availableDimensions === null ? null : (() => {
    const dimension = availableDimensions.find(candidate => candidate.key === loadedQuery.groupBy);
    if (dimension === undefined) throw new RangeError(`Unknown Usage grouping dimension: ${loadedQuery.groupBy}`);
    return dimension;
  })();
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
      range: loadedQuery.range,
      buckets,
    });
  }, [buckets, loadedQuery.range, metric, selectedDimension, usage]);
  const searchChart = useMemo(
    () => search && buildSearchChart({ search, range: loadedQuery.range, buckets }),
    [buckets, loadedQuery.range, search],
  );
  // Recorded search traffic stays visible after the operator turns search off.
  // A failed fetch does not establish that there was no search traffic.
  const showSearch = searchChart === null || searchChart.entries.length > 0;

  const changeGroupBy = (next: UsageGroupBy) => {
    if (next === query.groupBy) return;
    setQuery(current => ({
      ...current,
      ...changeTelemetryGroupBy(current, next, identityContext),
    }));
  };
  const changeRange = (next: UsageRange) => {
    if (next === query.range) return;
    setQuery(current => ({ ...current, range: next }));
  };
  const setFilter = (key: UsageGroupBy, values: string[]) => setQuery(current => ({
    ...current,
    ...changeTelemetryFilter(current, key, values, identityContext),
  }));

  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions appearance="subtle" onRefresh={() => void refresh()} refreshLabel={t('dashboard.usage.actions.refresh')} refreshing={refreshing} />}
      description={t('dashboard.pages.usage')}
      title={t('dashboard.nav.usage')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}

    <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
      <div className="flex items-end gap-3 min-w-0 flex-wrap">
        {availableDimensions && <TelemetryGroupByField
          disabled={refreshing}
          dimensions={availableDimensions}
          groupBy={loadedQuery.groupBy}
          groupByAdornment={loadedQuery.groupBy === 'keyId' && <Tooltip content={t('dashboard.usage.apiKeyScopeInfo')} relationship="description">
            <Button
              appearance="subtle"
              aria-label={t('dashboard.usage.apiKeyScopeLabel')}
              className={CONTROL_ROW_CLASS}
              icon={<InfoRegular />}
            />
          </Tooltip>}
          groupByLabel={t('dashboard.usage.groupBy.label')}
          onGroupByChange={changeGroupBy}
        />}
        <div className="ml-auto flex-none">
          <ChoiceGroup
            ariaLabel={t('dashboard.usage.range.label')}
            disabled={refreshing}
            items={[
              { value: 'today', label: t('dashboard.usage.range.today'), to: addressOf({ range: 'today' }) },
              { value: '7d', label: t('dashboard.usage.range.sevenDays'), to: addressOf({ range: '7d' }) },
              { value: '30d', label: t('dashboard.usage.range.thirtyDays'), to: addressOf({ range: '30d' }) },
            ]}
            onChange={value => changeRange(value as UsageRange)}
            value={loadedQuery.range}
          />
        </div>
      </div>
      {availableDimensions && <div className="flex items-end gap-3 min-w-0 flex-wrap">
        <TelemetryFilterFields
          disabled={refreshing}
          dimensions={availableDimensions}
          filters={loadedQuery.filters}
          groupBy={loadedQuery.groupBy}
          onFilterChange={setFilter}
          selectedLabel={count => t('dashboard.usage.filters.selected', { count })}
        />
      </div>}

      {tokenChart === null || summary === null || selectedDimension === null ? (
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
