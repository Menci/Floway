import { EyeOffRegular, EyeRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect, useSearchParams, type ShouldRevalidateFunctionArgs } from 'react-router';

import type { Route } from './+types/dashboard-monitor-usage';
import { useDashboardOutletContext } from './dashboard';
import type { GlobalError } from '../api/auth';
import type { ControlPlaneModel } from '../api/types';
import { getSessionToken } from '../auth/session';
import { ChoiceGroup } from '../components/ui/choice-group';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { buildSearchChart, buildTokenChart, dashboardBuckets, formatMetricValue, formatProvider, summarizeUsage } from '../components/usage/chart-model';
import { ChartSection } from '../components/usage/chart-section';
import { SummaryMetrics } from '../components/usage/summary-metrics';
import type { UsageMetric, UsageRange, UsageView } from '../components/usage/types';
import { loadUsagePageData } from '../components/usage/usage-data';
import { fluentComponents } from '../fluent';
import { errorMessage } from '../lib/error-message';
import { formatCount } from '../lib/format-number';
import { useLocale } from '../lib/use-locale';
import { useAuthStore } from '../stores/auth-store';

const { Button, Tooltip } = fluentComponents;
const usageMetricValues: UsageMetric[] = ['requests', 'cost', 'total', 'input', 'output', 'prefill', 'cached', 'cachedRate', 'cacheCreation', 'cacheHitRate'];
const usageRangeValues: UsageRange[] = ['today', '7d', '30d'];

type LoaderData = Awaited<ReturnType<typeof loadUsagePageData>> & {
  loadedAt: number;
  metric: UsageMetric;
  range: UsageRange;
  redactKeys: boolean;
  hiddenKeys: string[];
  hiddenModels: string[];
  view: UsageView;
};

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const user = await useAuthStore.getState().initialize();
  if (!user) throw redirect('/');
  const search = new URL(request.url).searchParams;
  const requestedView = search.get('view');
  const view: UsageView = user.isAdmin && requestedView === 'self-by-key' ? 'self-by-key' : user.isAdmin ? 'all-by-user' : 'self-by-key';
  const requestedRange = search.get('range') as UsageRange | null;
  const range = requestedRange && usageRangeValues.includes(requestedRange) ? requestedRange : 'today';
  const requestedMetric = search.get('metric') as UsageMetric | null;
  const metric = requestedMetric && usageMetricValues.includes(requestedMetric) ? requestedMetric : 'total';
  const loadedAt = Date.now();
  return {
    ...await loadUsagePageData(view, range, loadedAt),
    loadedAt,
    metric,
    range,
    redactKeys: search.get('redact') === '1',
    hiddenKeys: search.getAll('hideKey'),
    hiddenModels: search.getAll('hideModel'),
    view,
  };
}
export function meta({}: Route.MetaArgs) { return [{ title: 'Usage | Floway' }]; }
export const shouldRevalidate = ({ currentUrl, defaultShouldRevalidate, nextUrl }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname === nextUrl.pathname ? false : defaultShouldRevalidate;

export default function DashboardMonitorUsage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const [, setSearchParams] = useSearchParams();
  const clearAuth = useAuthStore(state => state.clear);
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<GlobalError | null>(loaderData.error);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);

  const canSwitchView = user.isAdmin;
  const locale = useLocale();

  // A background poll must not clear a failure the operator has not read:
  // these pages reload themselves every minute, and wiping the bar on the way
  // in meant a server's own words could appear and vanish unseen.
  const refresh = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    const requestedView = view;
    const requestedRange = range;
    const requestedAt = Date.now();
    setLoading(true);
    if (!background) setError(null);

    try {
      const next = await loadUsagePageData(
        requestedView,
        requestedRange,
        requestedAt,
      );
      if (
        requestId !== requestIdRef.current ||
        requestedView !== view ||
        requestedRange !== range
      ) {
        return;
      }
      setUsage(next.usage);
      setSearch(next.search);
      setModels(next.models);
      setLoadedRange(requestedRange);
      setLoadedAt(requestedAt);
      setError(next.error);
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      setError({ status: 0, message: errorMessage(caught) });
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [range, view]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  usePollWhileVisible(refresh, 60_000);

  // The session is gone, not the page: the gateway said so with a status, and
  // only the status says it -- a 401 body carrying its own words never matches
  // a message comparison.
  useEffect(() => {
    if (error?.status === 401) clearAuth();
  }, [clearAuth, error]);

  useEffect(() => {
    const next = new URLSearchParams({ view, range, metric });
    if (redactKeys) next.set('redact', '1');
    for (const id of [...hiddenKeys].sort()) next.append('hideKey', id);
    for (const id of [...hiddenModels].sort()) next.append('hideModel', id);
    setSearchParams(next, { replace: true });
  }, [hiddenKeys, hiddenModels, metric, range, redactKeys, setSearchParams, view]);

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

  // The panel follows the data, not the switch: recorded search traffic stays
  // visible after the operator turns search off or moves to another provider.
  // An unavailable half still gets its panel, because "no search traffic" is
  // not something a failed fetch establishes.
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
          refreshing={loading}
        />}
        description={t('dashboard.pages.usage')}
        title={t('dashboard.nav.usage')}
      />

      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}

      <Panel className="!grid !gap-[18px] min-w-0">
        <div className="flex items-center gap-3 justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch">
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
            <ChartSection
              chart={byKeyChart}
              detailsLabel={chartTitle}
              hidden={hiddenKeys}
              onHiddenChange={setHiddenKeys}
              title={chartTitle}
              valueFormatter={value => formatMetricValue(value, metric, locale)}
            />

            <ChartSection
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
        <Panel className="!grid !gap-[18px] min-w-0">
          {searchChart === null ? (
            <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine>
          ) : (
            <ChartSection
              chart={searchChart}
              detailsLabel={t('dashboard.usage.charts.search')}
              hidden={hiddenKeys}
              onHiddenChange={setHiddenKeys}
              title={t('dashboard.usage.charts.searchWithProvider', {
                provider: searchChart.providers.map(formatProvider).join(' · '),
              })}
              valueFormatter={value => formatCount(value, locale)}
            />
          )}
        </Panel>
      )}
    </section>
  );
}
