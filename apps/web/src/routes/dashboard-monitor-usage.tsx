import { ArrowClockwiseRegular, EyeOffRegular, EyeRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-monitor-usage';
import { useDashboardOutletContext } from './dashboard';
import type { ControlPlaneModel } from '../api/types';
import { getSessionToken } from '../auth/session';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Panel } from '../components/ui/panel';
import { SegmentedControl } from '../components/ui/segmented-control';
import { buildSearchChart, buildTokenChart, dashboardBuckets, formatCount, formatMetricValue, formatProvider, summarizeUsage } from '../components/usage/chart-model';
import { ChartSection } from '../components/usage/chart-section';
import { SummaryMetrics } from '../components/usage/summary-metrics';
import type { UsageMetric, UsageRange, UsageView } from '../components/usage/types';
import { loadUsagePageData } from '../components/usage/usage-data';
import { fluentComponents } from '../fluent';
import { localeForLanguage } from '../i18n';
import { useAuthStore } from '../stores/auth-store';

const { Button, makeStyles, Text, Tooltip } = fluentComponents;
const useErrorStyles = makeStyles({ root: { backgroundColor: 'var(--colorPaletteRedBackground2)', border: '1px solid var(--colorPaletteRedBorder1)', borderRadius: '8px', color: 'var(--colorPaletteRedForeground1)', padding: '10px 12px' } });

type LoaderData = Awaited<ReturnType<typeof loadUsagePageData>> & {
  loadedAt: number;
  range: UsageRange;
  view: UsageView;
};

export async function clientLoader(): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const user = await useAuthStore.getState().initialize();
  if (!user) throw redirect('/');
  const view: UsageView = user.isAdmin ? 'all-by-user' : 'self-by-key';
  const range: UsageRange = 'today';
  const loadedAt = Date.now();
  return { ...await loadUsagePageData(view, range, loadedAt), loadedAt, range, view };
}
export function meta({}: Route.MetaArgs) { return [{ title: 'Usage | Floway' }]; }

export default function DashboardMonitorUsage({ loaderData }: Route.ComponentProps) {
  const { i18n, t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const clearAuth = useAuthStore(state => state.clear);
  const [view, setView] = useState<UsageView>(loaderData.view);
  const [range, setRange] = useState<UsageRange>(loaderData.range);
  const [loadedRange, setLoadedRange] = useState<UsageRange>(loaderData.range);
  const [loadedAt, setLoadedAt] = useState(loaderData.loadedAt);
  const [usage, setUsage] = useState(loaderData.usage);
  const [search, setSearch] = useState(loaderData.search);
  const [models, setModels] = useState<ControlPlaneModel[]>(loaderData.models);
  const [metric, setMetric] = useState<UsageMetric>('total');
  const [redactKeys, setRedactKeys] = useState(false);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(loaderData.error);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);

  const errorStyles = useErrorStyles();

  const canSwitchView = user.isAdmin;
  const locale = localeForLanguage(i18n.language);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const requestedView = view;
    const requestedRange = range;
    const requestedAt = Date.now();
    setLoading(true);
    setError(null);

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
      setError(caught instanceof Error ? caught.message : String(caught));
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

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (error === 'HTTP 401') clearAuth();
  }, [clearAuth, error]);

  const buckets = useMemo(
    () => dashboardBuckets(loadedRange, loadedAt, locale),
    [loadedAt, loadedRange, locale],
  );

  const summary = useMemo(
    () =>
      summarizeUsage(
        usage.records.filter(
          record =>
            !hiddenKeys.has(record.keyId) && !hiddenModels.has(record.model),
        ),
      ),
    [hiddenKeys, hiddenModels, usage.records],
  );

  const byKeyChart = useMemo(
    () =>
      buildTokenChart({
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
      usage.keys,
      usage.records,
    ],
  );

  const byModelChart = useMemo(
    () =>
      buildTokenChart({
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
      usage.keys,
      usage.records,
    ],
  );

  const searchChart = useMemo(
    () =>
      buildSearchChart({
        search,
        hiddenKeys,
        redactKeys,
        range: loadedRange,
        buckets,
      }),
    [buckets, hiddenKeys, loadedRange, redactKeys, search],
  );

  const activeProvider = search.activeProvider ?? 'disabled';
  const showSearch = activeProvider !== 'disabled';
  const chartTitle =
    view === 'all-by-user'
      ? t('dashboard.usage.charts.byUser')
      : t('dashboard.usage.charts.byKey');

  return (
    <section className="grid gap-[18px] min-w-0">
      <DashboardPageHeader
        actions={<>
          <Tooltip
            content={t('dashboard.usage.actions.refresh')}
            relationship="label"
          >
            <Button
              appearance="subtle"
              disabled={loading}
              icon={<ArrowClockwiseRegular />}
              onClick={() => void refresh()}
            />
          </Tooltip>
        </>}
        description={t('dashboard.pages.usage')}
        eyebrow={t('dashboard.groups.monitor')}
        title={t('dashboard.nav.usage')}
      />

      {error && <div className={errorStyles.root}>{error}</div>}

      <Panel className="!grid gap-[18px] min-w-0 !p-[18px]">
        <div className="flex items-center gap-3 justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch">
          <div className="flex items-center flex-wrap gap-2.5 min-w-0">
            <Text size={200} weight="semibold" className="text-fui-fg3 leading-[1.2]">
              {t('dashboard.usage.tokenUsage')}
            </Text>
            {canSwitchView && (
              <SegmentedControl
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
            <Tooltip
              content={
                view === 'all-by-user'
                  ? t('dashboard.usage.actions.redactUsers')
                  : t('dashboard.usage.actions.redactKeys')
              }
              relationship="label"
            >
              <Button
                appearance={redactKeys ? 'primary' : 'subtle'}
                icon={redactKeys ? <EyeOffRegular /> : <EyeRegular />}
                onClick={() => setRedactKeys(value => !value)}
              />
            </Tooltip>
          </div>

          <SegmentedControl
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

        <SummaryMetrics locale={locale} metric={metric} onMetricChange={setMetric} summary={summary} />

      </Panel>

      {showSearch && (
        <Panel className="!grid gap-[18px] min-w-0 !p-[18px]">
          <ChartSection
            chart={searchChart}
            detailsLabel={t('dashboard.usage.charts.search')}
            hidden={hiddenKeys}
            onHiddenChange={setHiddenKeys}
            title={t('dashboard.usage.charts.searchWithProvider', {
              provider: formatProvider(activeProvider),
            })}
            valueFormatter={value => formatCount(value, locale)}
          />
        </Panel>
      )}
    </section>
  );
}
