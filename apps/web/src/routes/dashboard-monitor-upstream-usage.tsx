import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-upstream-usage';
import { requireDashboardAdmin } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { parseDashboardRange, serializeDashboardRange, sameDashboardRange, type DashboardRange } from '../components/charts/dashboard-time';
import { TelemetryTimeRange } from '../components/telemetry/time-range';
import { useTelemetryPolling } from '../components/telemetry/use-poll';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Dropdown } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { useRefreshOnChange } from '../components/ui/use-refresh';
import { UpstreamUsageChartSection } from '../components/upstream-usage/chart';
import { loadUpstreamUsage } from '../components/upstream-usage/data';
import { resolveUsageMetricDisplayName } from '../components/upstream-usage/display-name';
import { buildUpstreamUsageCharts, type UpstreamUsageGroupBy } from '../components/upstream-usage/plot';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';
import { useEntryRewrite } from '../lib/page-navigation';

const { Field, Option } = fluentComponents;

export const clientLoader = async ({ request }: Route.ClientLoaderArgs) => {
  await requireDashboardAdmin();
  const search = new URL(request.url).searchParams;
  const range = parseDashboardRange(search);
  const loadedAt = Date.now();
  return { range, groupBy: search.get('g') === 'metric' ? 'metric' as const : 'upstream' as const, result: await loadUpstreamUsage(range, loadedAt), loadedAt };
};
export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardMonitorUpstreamUsage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  const [query, setQuery] = useState({ range: loaderData.range });
  const range = query.range;
  const [groupBy, setGroupBy] = useState<UpstreamUsageGroupBy>(loaderData.groupBy);
  const [data, setData] = useState(loaderData.result.data ?? null);
  const [error, setError] = useState(loaderData.result.error ?? null);
  const [editingRange, setEditingRange] = useState(false);
  const reload = useCallback(async (signal: AbortSignal, { requestedAt }: { requestedAt: number }) => {
    const result = await loadUpstreamUsage(range, requestedAt, signal);
    if (signal.aborted) return false;
    setError(result.error ?? null);
    if (result.error) return false;
    setData(result.data);
    return true;
  }, [range]);
  const { loadedAt, loadedQuery, poll, refresh, refreshing } = useRefreshOnChange(query, loaderData.loadedAt, reload, setQuery);
  const loadedRange = loadedQuery.range;
  useTelemetryPolling(poll, loadedRange, !editingRange && !refreshing);
  const addressOf = (next: DashboardRange) => {
    const search = new URLSearchParams();
    serializeDashboardRange(search, next);
    if (groupBy === 'metric') search.set('g', groupBy);
    return `?${search}`;
  };
  useEffect(() => {
    const search = new URLSearchParams();
    serializeDashboardRange(search, loadedRange);
    if (groupBy === 'metric') search.set('g', groupBy);
    setSearchParams(search, rewrite);
  }, [groupBy, loadedRange, rewrite, setSearchParams]);
  const charts = useMemo(() => {
    if (data === null || data.start >= loadedAt) return [];
    const upstreams = new Map(data.records.map(record => [record.upstreamId, record]));
    return buildUpstreamUsageCharts(data.records, groupBy, (upstreamId, key) => resolveUsageMetricDisplayName(upstreamId, key, upstreams, t));
  }, [data, groupBy, loadedAt, t]);
  const changeRange = (next: DashboardRange) => {
    if (sameDashboardRange(next, range)) void refresh();
    else setQuery({ range: next });
  };
  return <section className="dashboard-page">
    <DashboardPageHeader title={t('dashboard.nav.upstreamUsage')} description={t('dashboard.pages.upstreamUsage')} actions={<ResourceListActions appearance="subtle" onRefresh={() => void refresh()} refreshLabel={t('dashboard.upstreamUsage.refresh')} refreshing={refreshing} />} />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error.message}</OutcomeMessageBar>}
    <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
      <div className="flex items-end gap-3 min-w-0 flex-wrap">
        <Field className="w-[160px] flex-none" label={t('dashboard.usage.groupBy.label')}>
          <Dropdown aria-label={t('dashboard.usage.groupBy.label')} disabled={refreshing} selectedOptions={[groupBy]} value={t(`dashboard.upstreamUsage.groupBy.${groupBy}`)} onOptionSelect={(_, selection) => {
            if (selection.optionValue !== undefined) setGroupBy(selection.optionValue as UpstreamUsageGroupBy);
          }}>
            <Option value="upstream">{t('dashboard.upstreamUsage.groupBy.upstream')}</Option>
            <Option value="metric">{t('dashboard.upstreamUsage.groupBy.metric')}</Option>
          </Dropdown>
        </Field>
        <div className="ml-auto flex-none"><TelemetryTimeRange addressOf={addressOf} ariaLabel={t('dashboard.usage.range.label')} loadedAt={loadedAt} onChange={changeRange} onEditingChange={setEditingRange} range={loadedRange} /></div>
      </div>
      {data === null ? <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine> : charts.length === 0 ? <EmptyStateLine>{t('dashboard.upstreamUsage.empty')}</EmptyStateLine> : charts.map(chart => <UpstreamUsageChartSection chart={chart} end={Math.min(data.end, loadedAt)} key={JSON.stringify([groupBy, chart.id])} start={data.start} />)}
    </Panel>
  </section>;
}
