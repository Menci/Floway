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
import { emptySearchUsageResponse, emptyUsageResponse, loadUsagePageData } from '../components/usage/usage-data';
import { fluentComponents } from '../fluent';
import { localeForLanguage } from '../i18n';
import { useNow } from '../lib/use-now';
import { useAuthStore } from '../stores/auth-store';

const { Button, makeStyles, Spinner, Text, Tooltip } = fluentComponents;
const useErrorStyles = makeStyles({ root: { backgroundColor: 'var(--colorPaletteRedBackground2)', border: '1px solid var(--colorPaletteRedBorder1)', borderRadius: '8px', color: 'var(--colorPaletteRedForeground1)', padding: '10px 12px' } });

export async function clientLoader() { if (!getSessionToken()) throw redirect('/'); return null; }
export function meta({}: Route.MetaArgs) { return [{ title: 'Usage | Floway' }]; }

export default function DashboardMonitorUsage() {
  const { i18n, t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const clearAuth = useAuthStore(state => state.clear);
  const initialView: UsageView = user.isAdmin ? 'all-by-user' : 'self-by-key';
  const [view, setView] = useState<UsageView>(initialView);
  const [range, setRange] = useState<UsageRange>('today');
  const [loadedRange, setLoadedRange] = useState<UsageRange>('today');
  // Stamped by each completed load; the initial value only has to be a
  // stable reading, which the shared clock provides without an impure render.
  const mountClock = useNow(60_000);
  const [loadedAt, setLoadedAt] = useState(mountClock);
  const [usage, setUsage] = useState(emptyUsageResponse);
  const [search, setSearch] = useState(emptySearchUsageResponse);
  const [models, setModels] = useState<ControlPlaneModel[]>([]);
  const [metric, setMetric] = useState<UsageMetric>('total');
  const [redactKeys, setRedactKeys] = useState(false);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

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
        user,
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
        setInitialLoading(false);
      }
    }
  }, [range, user, view]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The filters are user-selected, so a change starts a load; marking it pending synchronously is the point.
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
          {loading && !initialLoading && <Spinner size="tiny" label={t('dashboard.usage.refreshing')} />}
          <Tooltip
            content={t('dashboard.usage.actions.refresh')}
            relationship="label"
          >
            <Button
              appearance="subtle"
              disabled={initialLoading}
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
