import { EyeOffRegular, EyeRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect, useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-usage';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardSession } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import type { GlobalError } from '../api/client';
import type { ControlPlaneModel } from '../api/types';
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
import { formatMetricValue, formatProvider } from '../components/usage/format';
import { buildSearchChart, buildTokenChart, dashboardBuckets, summarizeUsage } from '../components/usage/plot';
import { SummaryMetrics } from '../components/usage/summary-metrics';
import type { UsageMetric, UsageRange, UsageView } from '../components/usage/types';
import { parseUsageUrlState, serializeUsageUrlState, type UsageUrlState } from '../components/usage/url-state';
import { fluentComponents } from '../fluent';
import { errorMessage } from '../lib/error-message';
import { formatCount } from '../lib/format-number';
import { useEntryRewrite } from '../lib/page-navigation';
import { useLocale } from '../lib/use-locale';
import { useAuthStore } from '../stores/auth-store';

const { Button, Tooltip } = fluentComponents;

type LoaderData = Awaited<ReturnType<typeof loadUsagePageData>> & UsageUrlState & { loadedAt: number };

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  requireDashboardSession();
  const user = await useAuthStore.getState().initialize();
  if (!user) throw redirect('/');
  const state = parseUsageUrlState(new URL(request.url).searchParams);
  const view: UsageView = user.isAdmin ? state.view : 'self-by-key';
  const loadedAt = Date.now();
  return {
    ...await loadUsagePageData(view, state.range, loadedAt),
    ...state,
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
  const [metric, setMetric] = useState<UsageMetric>(loaderData.metric);
  const [redactKeys, setRedactKeys] = useState(loaderData.redactKeys);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set(loaderData.hiddenKeys));
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set(loaderData.hiddenModels));
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const query = useMemo(() => ({ range, view }), [range, view]);

  const canSwitchView = user.isAdmin;
  const locale = useLocale();

  // A background poll must not clear a failure the operator has not read: these
  // pages reload themselves every minute.
  const reload = useCallback(async (signal: AbortSignal, { background }: { background: boolean }, arrived: () => void) => {
    const requestedAt = Date.now();
    if (!background) setError(null);
    try {
      const next = await loadUsagePageData(query.view, query.range, requestedAt, signal);
      if (signal.aborted) return;
      setUsage(next.usage);
      setSearch(next.search);
      setModels(next.models);
      setLoadedRange(query.range);
      setLoadedAt(requestedAt);
      arrived();
      setError(next.error);
    } catch (error) {
      if (signal.aborted) return;
      setError({ status: 0, message: errorMessage(error) });
    }
  }, [query]);

  const { poll, refresh, refreshing } = useRefreshOnChange(query, reload);

  usePollWhileVisible(poll);

  useEffect(() => {
    setSearchParams(serializeUsageUrlState({ view, range, metric, redactKeys, hiddenKeys: [...hiddenKeys], hiddenModels: [...hiddenModels] }), rewrite);
  }, [hiddenKeys, hiddenModels, metric, range, redactKeys, rewrite, setSearchParams, view]);

  const buckets = useMemo(
    () => dashboardBuckets(loadedRange, loadedAt, locale),
    [loadedAt, loadedRange, locale],
  );

  const summary = useMemo(
    () => usage && summarizeUsage(
      usage.records.filter(
        record =>
          !hiddenKeys.has(record.keyId) && !hiddenModels.has(record.model),
      ),
    ),
    [hiddenKeys, hiddenModels, usage],
  );

  const byKeyChart = useMemo(
    () => usage && models && buildTokenChart({
      records: usage.records,
      metadata: usage.keys,
      models,
      groupKey: 'keyId',
      hiddenOwn: hiddenKeys,
      hiddenOther: hiddenModels,
      redactKeys,
      metric,
      range: loadedRange,
      buckets,
    }),
    [
      buckets,
      hiddenKeys,
      hiddenModels,
      loadedRange,
      metric,
      models,
      redactKeys,
      usage,
    ],
  );

  const byModelChart = useMemo(
    () => usage && models && buildTokenChart({
      records: usage.records,
      metadata: usage.keys,
      models,
      groupKey: 'model',
      hiddenOwn: hiddenModels,
      hiddenOther: hiddenKeys,
      redactKeys,
      metric,
      range: loadedRange,
      buckets,
    }),
    [
      buckets,
      hiddenKeys,
      hiddenModels,
      loadedRange,
      metric,
      models,
      redactKeys,
      usage,
    ],
  );

  const searchChart = useMemo(
    () => search && buildSearchChart({
      search,
      hiddenKeys,
      redactKeys,
      range: loadedRange,
      buckets,
    }),
    [buckets, hiddenKeys, loadedRange, redactKeys, search],
  );

  // Recorded search traffic stays visible after the operator turns search off.
  // An unavailable half still gets its panel: "no search traffic" is not
  // something a failed fetch establishes.
  const showSearch = searchChart === null || searchChart.entries.length > 0;
  const chartTitle =
    view === 'all-by-user'
      ? t('dashboard.usage.charts.byUser')
      : t('dashboard.usage.charts.byKey');
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
        <div className={`${HEADER_ROW_CLASS} gap-3`}>
          <div className="flex items-center flex-wrap gap-2.5 min-w-0">
            {canSwitchView && (
              <ChoiceGroup
                ariaLabel={t('dashboard.usage.view.label')}
                items={[
                  {
                    value: 'all-by-user',
                    label: t('dashboard.usage.view.allByUser'),
                  },
                  {
                    value: 'self-by-key',
                    label: t('dashboard.usage.view.myKeys'),
                  },
                ]}
                onChange={value => setView(value as UsageView)}
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
              { value: 'today', label: t('dashboard.usage.range.today') },
              { value: '7d', label: t('dashboard.usage.range.sevenDays') },
              { value: '30d', label: t('dashboard.usage.range.thirtyDays') },
            ]}
            onChange={value => setRange(value as UsageRange)}
            value={range}
          />
        </div>

        {byKeyChart === null || byModelChart === null || summary === null ? (
          <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine>
        ) : (
          <>
            <UsageChartSection
              chart={byKeyChart}
              detailsLabel={chartTitle}
              hidden={hiddenKeys}
              onHiddenChange={setHiddenKeys}
              title={chartTitle}
              valueFormatter={value => formatMetricValue(value, metric, locale)}
            />

            <UsageChartSection
              chart={byModelChart}
              detailsLabel={t('dashboard.usage.charts.byModel')}
              hidden={hiddenModels}
              onHiddenChange={setHiddenModels}
              title={t('dashboard.usage.charts.byModel')}
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
                provider: searchChart.providers.map(formatProvider).join(', '),
              })}
              valueFormatter={value => formatCount(value, locale)}
            />
          )}
        </Panel>
      )}
    </section>
  );
}
