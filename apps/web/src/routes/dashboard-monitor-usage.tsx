import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-monitor-usage';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import type { GlobalError } from '../api/client';
import { sameDashboardRange } from '../components/charts/dashboard-time';
import { SEARCH_PROVIDER_LABEL_KEYS } from '../components/search/provider';
import { TelemetryFilterFields } from '../components/telemetry/dimension-controls';
import { changeTelemetryFilter, changeTelemetryGroupBy, scopeTelemetryIdentity } from '../components/telemetry/filter-state';
import { TelemetryTimeRange } from '../components/telemetry/time-range';
import { useTelemetryPolling } from '../components/telemetry/use-poll';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { useRefreshOnChange } from '../components/ui/use-refresh';
import { UsageChartSection } from '../components/usage/chart-section';
import { loadUsagePageData } from '../components/usage/data';
import { usageDimensions } from '../components/usage/dimensions';
import { UsageGrouping } from '../components/usage/grouping';
import { buildSearchChart, dashboardBuckets } from '../components/usage/plot';
import { TokenUsageCharts } from '../components/usage/token-charts';
import type { UsageGroupBy, UsageMetric, UsageRange } from '../components/usage/types';
import { parseUsageUrlState, serializeUsageUrlState, type UsageUrlState } from '../components/usage/url-state';
import { formatCount } from '../lib/format-number';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';

type LoaderData = Awaited<ReturnType<typeof loadUsagePageData>> & {
  currentUserId: string;
  loadedAt: number;
  state: UsageUrlState;
};

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  const user = await requireDashboardUser();
  const parsed = parseUsageUrlState(new URL(request.url).searchParams);
  const scoped = scopeTelemetryIdentity(parsed.groupBy, parsed.filters, {
    currentUserId: String(user.id),
    fallbackGroup: 'model',
    userDimensionAvailable: true,
  });
  const loadedAt = Date.now();
  return {
    ...await loadUsagePageData(String(user.id), parsed.range, scoped.groupBy, scoped.filters, loadedAt),
    currentUserId: String(user.id),
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
  const auditableUserIdsRef = useRef(loaderData.usage?.auditableUserIds ?? [Number(loaderData.currentUserId)]);
  const locale = useLocale();
  const identityContext = {
    currentUserId: loaderData.currentUserId,
    fallbackGroup: 'model' as const,
    userDimensionAvailable: true,
  };

  const reload = useCallback(async (signal: AbortSignal, { background, requestedAt }: { background: boolean; requestedAt: number }) => {
    if (!background) setError(null);
    const next = await loadUsagePageData(loaderData.currentUserId, query.range, query.groupBy, query.filters, requestedAt, signal, auditableUserIdsRef.current);
    if (signal.aborted) return false;
    if (next.usage === null) {
      setError(next.error);
      return false;
    }
    setUsage(next.usage);
    auditableUserIdsRef.current = next.usage.auditableUserIds;
    setSearch(next.search);
    setUpstreams(next.upstreams);
    setError(next.error);
    return true;
  }, [loaderData.currentUserId, query]);

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

  const urlState = useMemo<UsageUrlState>(
    () => ({ ...loadedQuery, metric, hidden: [...hiddenSeries], hiddenSearch: [...hiddenSearch] }),
    [hiddenSearch, hiddenSeries, loadedQuery, metric],
  );
  useEffect(() => {
    setSearchParams(serializeUsageUrlState(urlState), rewrite);
  }, [rewrite, setSearchParams, urlState]);
  const addressOf = (patch: Partial<UsageUrlState>) => `?${serializeUsageUrlState({ ...urlState, ...patch })}`;

  const buckets = useMemo(() => dashboardBuckets(loadedQuery.range, loadedAt), [loadedAt, loadedQuery.range]);
  const availableDimensions = useMemo(() => usage === null ? null : usageDimensions({
    usage, upstreams,
    currentUserId: loaderData.currentUserId, t,
  }), [loaderData.currentUserId, t, upstreams, usage]);
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
    if (sameDashboardRange(next, query.range)) {
      void refresh();
      return;
    }
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
        {availableDimensions && <UsageGrouping disabled={refreshing} dimensions={availableDimensions} groupBy={loadedQuery.groupBy} onChange={changeGroupBy} />}
        <div className="ml-auto flex-none">
          <TelemetryTimeRange
            addressOf={range => addressOf({ range })}
            ariaLabel={t('dashboard.usage.range.label')}
            loadedAt={loadedAt}
            onChange={changeRange}
            onEditingChange={setEditingRange}
            range={loadedQuery.range}
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

      <TokenUsageCharts usage={usage} dimensions={availableDimensions} upstreams={upstreams} groupBy={loadedQuery.groupBy} range={loadedQuery.range}
        loadedAt={loadedAt} metric={metric} onMetricChange={setMetric} hidden={hiddenSeries} onHiddenChange={setHiddenSeries} title={null} />
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
