import { EyeOffRegular, EyeRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-usage';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import type { GlobalError } from '../api/client';
import type { ControlPlaneModel } from '../api/types';
import { SEARCH_PROVIDER_LABEL_KEYS } from '../components/search/provider';
import { TelemetryDimensionControls, type TelemetryDimension } from '../components/telemetry/dimension-controls';
import { ChoiceGroup } from '../components/ui/choice-group';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { HEADER_ROW_CLASS, PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefreshOnChange } from '../components/ui/use-refresh';
import { UsageChartSection } from '../components/usage/chart-section';
import { loadUsagePageData } from '../components/usage/data';
import { clearGroupedUsageFilter, filterUsageRecords, usageUpstreamValue } from '../components/usage/dimensions';
import { formatMetricValue } from '../components/usage/format';
import { buildSearchChart, buildTokenChart, dashboardBuckets, summarizeUsage } from '../components/usage/plot';
import { SummaryMetrics } from '../components/usage/summary-metrics';
import type { UsageFilters, UsageGroupBy, UsageMetric, UsageRange, UsageView } from '../components/usage/types';
import { parseUsageUrlState, serializeUsageUrlState, type UsageUrlState } from '../components/usage/url-state';
import { fluentComponents } from '../fluent';
import { formatCount } from '../lib/format-number';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';

const { Button, Tooltip } = fluentComponents;

type LoaderData = Awaited<ReturnType<typeof loadUsagePageData>> & UsageUrlState & { loadedAt: number };

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  const user = await requireDashboardUser();
  const state = parseUsageUrlState(new URL(request.url).searchParams);
  const view: UsageView = user.isAdmin ? state.view : 'self-by-key';
  const loadedAt = Date.now();
  const identityState = view === state.view
    ? { filters: state.filters, hiddenKeys: state.hiddenKeys }
    : { filters: { ...state.filters, identity: [] }, hiddenKeys: [] };
  return {
    ...await loadUsagePageData(view, state.range, loadedAt),
    ...state,
    ...identityState,
    loadedAt,
    view,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardMonitorUsage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const [, setSearchParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  const [view, setView] = useState<UsageView>(loaderData.view);
  const [range, setRange] = useState<UsageRange>(loaderData.range);
  const [loadedRange, setLoadedRange] = useState<UsageRange>(loaderData.range);
  const [loadedAt, setLoadedAt] = useState(loaderData.loadedAt);
  const [usage, setUsage] = useState(loaderData.usage);
  const [search, setSearch] = useState(loaderData.search);
  const [models, setModels] = useState<ControlPlaneModel[] | null>(loaderData.models);
  const [upstreams, setUpstreams] = useState(loaderData.upstreams);
  const [metric, setMetric] = useState<UsageMetric>(loaderData.metric);
  const [groupBy, setGroupBy] = useState<UsageGroupBy>(loaderData.groupBy);
  const [filters, setFilters] = useState<UsageFilters>(loaderData.filters);
  const [redactKeys, setRedactKeys] = useState(loaderData.redactKeys);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set(loaderData.hiddenKeys));
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set(loaderData.hiddenModels));
  const [hiddenUpstreams, setHiddenUpstreams] = useState<Set<string>>(() => new Set(loaderData.hiddenUpstreams));
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const query = useMemo(() => ({ range, view }), [range, view]);

  const canSwitchView = user.isAdmin;
  const locale = useLocale();

  // A background poll must not clear a failure the operator has not read: these
  // pages reload themselves every minute.
  const reload = useCallback(async (signal: AbortSignal, { background }: { background: boolean }, arrived: () => void) => {
    const requestedAt = Date.now();
    if (!background) setError(null);
    const next = await loadUsagePageData(query.view, query.range, requestedAt, signal);
    if (signal.aborted) return;
    setUsage(next.usage);
    setSearch(next.search);
    setModels(next.models);
    setUpstreams(next.upstreams);
    setLoadedRange(query.range);
    setLoadedAt(requestedAt);
    arrived();
    setError(next.error);
  }, [query]);

  const { poll, refresh, refreshing } = useRefreshOnChange(query, reload);

  usePollWhileVisible(poll);

  const urlState = useMemo<UsageUrlState>(
    () => ({ view, range, groupBy, filters, metric, redactKeys, hiddenKeys: [...hiddenKeys], hiddenModels: [...hiddenModels], hiddenUpstreams: [...hiddenUpstreams] }),
    [filters, groupBy, hiddenKeys, hiddenModels, hiddenUpstreams, metric, range, redactKeys, view],
  );

  useEffect(() => {
    setSearchParams(serializeUsageUrlState(urlState), rewrite);
  }, [rewrite, setSearchParams, urlState]);

  // The page keeps the view in state and writes the URL after it, so each
  // choice carries the address its own view would be read at.
  const addressOf = (patch: Partial<UsageUrlState>) => `?${serializeUsageUrlState({ ...urlState, ...patch })}`;

  const buckets = useMemo(
    () => dashboardBuckets(loadedRange, loadedAt, locale),
    [loadedAt, loadedRange, locale],
  );

  const filteredRecords = useMemo(
    () => usage && filterUsageRecords(usage.records, filters),
    [filters, usage],
  );

  const summary = useMemo(
    () => filteredRecords && summarizeUsage(filteredRecords),
    [filteredRecords],
  );

  const tokenChart = useMemo(
    () => usage && filteredRecords && models && upstreams && buildTokenChart({
      records: filteredRecords,
      metadata: usage.keys,
      models,
      groupBy,
      upstreams,
      noUpstreamLabel: t('dashboard.usage.filters.noUpstream'),
      redactKeys,
      metric,
      range: loadedRange,
      buckets,
    }),
    [
      buckets,
      filteredRecords,
      groupBy,
      loadedRange,
      metric,
      models,
      redactKeys,
      t,
      upstreams,
      usage,
    ],
  );

  const searchChart = useMemo(
    () => search && buildSearchChart({
      search,
      redactKeys,
      range: loadedRange,
      buckets,
    }),
    [buckets, loadedRange, redactKeys, search],
  );

  // Recorded search traffic stays visible after the operator turns search off.
  // An unavailable half still gets its panel: "no search traffic" is not
  // something a failed fetch establishes.
  const showSearch = searchChart === null || searchChart.entries.length > 0;
  const dimensions = useMemo<Array<TelemetryDimension<UsageGroupBy>> | null>(() => {
    if (!usage || !upstreams) return null;
    const identityNames = new Map(usage.keys.map(key => [key.id, key.name]));
    const upstreamNames = new Map(upstreams.map(upstream => [usageUpstreamValue(upstream.id), upstream.name]));
    const options = (values: string[], labels: ReadonlyMap<string, string>) => [...new Set(values)]
      .sort((left, right) => (labels.get(left) ?? left).localeCompare(labels.get(right) ?? right))
      .map(value => ({ value, label: labels.get(value) ?? value }));
    const identityIsUser = view === 'all-by-user';
    return [
      {
        key: 'identity',
        groupLabel: t(identityIsUser ? 'dashboard.usage.charts.byUser' : 'dashboard.usage.charts.byKey'),
        filterLabel: t(identityIsUser ? 'dashboard.usage.filters.user' : 'dashboard.usage.filters.key'),
        allLabel: t(identityIsUser ? 'dashboard.usage.filters.allUsers' : 'dashboard.usage.filters.allKeys'),
        options: options(usage.records.map(record => record.keyId), identityNames),
      },
      {
        key: 'model',
        groupLabel: t('dashboard.usage.charts.byModel'),
        filterLabel: t('dashboard.usage.filters.model'),
        allLabel: t('dashboard.usage.filters.allModels'),
        options: options(usage.records.map(record => record.model), new Map()),
      },
      {
        key: 'upstream',
        groupLabel: t('dashboard.usage.charts.byUpstream'),
        filterLabel: t('dashboard.usage.filters.upstream'),
        allLabel: t('dashboard.usage.filters.allUpstreams'),
        options: options(
          usage.records.map(record => usageUpstreamValue(record.upstream)),
          new Map([...upstreamNames, [usageUpstreamValue(null), t('dashboard.usage.filters.noUpstream')]]),
        ),
      },
    ];
  }, [t, upstreams, usage, view]);
  const chartTitle = dimensions?.find(dimension => dimension.key === groupBy)?.groupLabel ?? '';
  const hiddenSeries = groupBy === 'identity' ? hiddenKeys : groupBy === 'model' ? hiddenModels : hiddenUpstreams;
  const setHiddenSeries = (next: Set<string>) => {
    if (groupBy === 'identity') setHiddenKeys(next);
    else if (groupBy === 'model') setHiddenModels(next);
    else setHiddenUpstreams(next);
  };
  const changeGroupBy = (next: UsageGroupBy) => {
    if (next === groupBy) return;
    setGroupBy(next);
    setFilters(current => clearGroupedUsageFilter(current, next));
  };
  const changeView = (next: UsageView) => {
    if (next === view) return;
    setView(next);
    setFilters(current => ({ ...current, identity: [] }));
    setHiddenKeys(new Set());
  };
  const setFilter = (key: UsageGroupBy, values: string[]) => setFilters(current => ({ ...current, [key]: values }));
  const viewAddress = (next: UsageView) => addressOf({
    view: next,
    filters: { ...filters, identity: [] },
    hiddenKeys: [],
  });
  const redactLabel =
    view === 'all-by-user'
      ? t('dashboard.usage.actions.redactUsers')
      : t('dashboard.usage.actions.redactKeys');

  return (
    <section className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          appearance="subtle"
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.usage.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.pages.usage')}
        title={t('dashboard.nav.usage')}
      />

      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}

      <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
        {dimensions && <TelemetryDimensionControls
          dimensions={dimensions}
          filters={filters}
          groupBy={groupBy}
          groupByLabel={t('dashboard.usage.groupBy')}
          onFilterChange={setFilter}
          onGroupByChange={changeGroupBy}
          selectedLabel={count => t('dashboard.usage.filters.selected', { count })}
        />}
        <div className={`${HEADER_ROW_CLASS} gap-3`}>
          <div className="flex items-center flex-wrap gap-2.5 min-w-0">
            {canSwitchView && (
              <ChoiceGroup
                ariaLabel={t('dashboard.usage.view.label')}
                items={[
                  {
                    value: 'all-by-user',
                    label: t('dashboard.usage.view.allByUser'),
                    to: viewAddress('all-by-user'),
                  },
                  {
                    value: 'self-by-key',
                    label: t('dashboard.usage.view.myKeys'),
                    to: viewAddress('self-by-key'),
                  },
                ]}
                onChange={value => changeView(value as UsageView)}
                value={view}
              />
            )}
            <Tooltip content={redactLabel} relationship="label">
              <Button
                appearance={redactKeys ? 'primary' : 'subtle'}
                aria-label={redactLabel}
                icon={redactKeys ? <EyeOffRegular /> : <EyeRegular />}
                onClick={() => setRedactKeys(value => !value)}
              />
            </Tooltip>
          </div>

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

        {tokenChart === null || summary === null || dimensions === null ? (
          <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine>
        ) : (
          <>
            <UsageChartSection
              chart={tokenChart}
              detailsLabel={chartTitle}
              hidden={hiddenSeries}
              onHiddenChange={setHiddenSeries}
              title={chartTitle}
              valueFormatter={value => formatMetricValue(value, metric, locale)}
            />
            <SummaryMetrics metric={metric} onMetricChange={setMetric} summary={summary} />
          </>
        )}

      </Panel>

      {showSearch && (
        <Panel className="min-w-0">
          {searchChart === null ? (
            <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine>
          ) : (
            <UsageChartSection
              chart={searchChart}
              detailsLabel={t('dashboard.usage.charts.search')}
              hidden={hiddenKeys}
              onHiddenChange={setHiddenKeys}
              title={t('dashboard.usage.charts.searchWithProvider', {
                provider: searchChart.providers
                  .map(id => SEARCH_PROVIDER_LABEL_KEYS[id] === undefined ? id : t(SEARCH_PROVIDER_LABEL_KEYS[id]))
                  .join(', '),
              })}
              valueFormatter={value => formatCount(value, locale)}
            />
          )}
        </Panel>
      )}
    </section>
  );
}
