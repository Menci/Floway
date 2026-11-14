import { useMemo, useState } from 'react';

import type { ApiResult } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { useTranslation } from '../../i18n/translation';
import { useUserPreferences } from '../../lib/use-preferences';
import { LinkedChartHoverProvider } from '../charts/linked-hover';
import { TelemetryFilterFields } from '../telemetry/dimension-controls';
import { changeTelemetryFilter, changeTelemetryGroupBy } from '../telemetry/filter-state';
import { TelemetryTimeRange } from '../telemetry/time-range';
import { PANEL_STACK_CLASS } from '../ui/layout';
import { PANEL_INSET_CLASS } from '../ui/panel';
import { TableExpansionRow } from '../ui/table-expansion-row';
import { UpstreamMetricsChartSection } from '../upstream-metrics/chart';
import { loadUpstreamMetrics } from '../upstream-metrics/data';
import { resolveUpstreamMetricDisplays } from '../upstream-metrics/display-name';
import { buildUpstreamMetricsChart } from '../upstream-metrics/plot';
import { loadUsageOverview } from '../usage/data';
import { usageDimensions } from '../usage/dimensions';
import { UsageGrouping } from '../usage/grouping';
import { TokenUsageCharts } from '../usage/token-charts';
import type { UsageFilters, UsageGroupBy, UsageMetric, UsageOverviewResponse, UsageRange } from '../usage/types';

export type UpstreamTelemetryQuery = {
  upstreamId: string | null;
  range: UsageRange;
  groupBy: UsageGroupBy;
  filters: UsageFilters;
};

export const loadUpstreamTelemetry = async (query: UpstreamTelemetryQuery, loadedAt: number, signal: AbortSignal): Promise<ApiResult<UpstreamTelemetryData>> => {
  if (query.upstreamId === null) throw new TypeError('Upstream telemetry requires an upstream ID');
  const [usage, metrics] = await Promise.all([
    loadUsageOverview(query.range, query.groupBy, query.filters, loadedAt, signal),
    loadUpstreamMetrics(query.upstreamId, query.range, loadedAt, signal),
  ]);
  if (usage.error) return { error: usage.error };
  if (metrics.error) return { error: metrics.error };
  return { data: { query, loadedAt, usage: usage.data, metrics: metrics.data } };
};
export interface UpstreamTelemetryData { query: UpstreamTelemetryQuery; loadedAt: number; usage: UsageOverviewResponse; metrics: NonNullable<Awaited<ReturnType<typeof loadUpstreamMetrics>>['data']> }

export function UpstreamTelemetryRow({ data, immediateCollapse, record, busy, currentUserId, onQueryChange, onRangeEditingChange }: {
  data: UpstreamTelemetryData | null;
  immediateCollapse: boolean;
  record: UpstreamRecord;
  busy: boolean;
  currentUserId: string;
  onQueryChange: (next: UpstreamTelemetryQuery) => void;
  onRangeEditingChange: (editing: boolean) => void;
}) {
  const [previous, setPrevious] = useState(data);
  const [resident, setResident] = useState(data);
  if (previous !== data || (immediateCollapse && resident !== null)) {
    setPrevious(data);
    if (immediateCollapse) setResident(null);
    else if (data !== null) setResident(data);
  }
  return <TableExpansionRow columns={6} open={data !== null} onCollapsed={() => setResident(null)}>
    {resident !== null && <UpstreamTelemetryPanel busy={busy} currentUserId={currentUserId} data={resident} record={record}
      onQueryChange={onQueryChange} onRangeEditingChange={onRangeEditingChange} />}
  </TableExpansionRow>;
}

function UpstreamTelemetryPanel({ data, record, busy, currentUserId, onQueryChange, onRangeEditingChange }: {
  data: UpstreamTelemetryData;
  record: UpstreamRecord;
  busy: boolean;
  currentUserId: string;
  onQueryChange: (next: UpstreamTelemetryQuery) => void;
  onRangeEditingChange: (editing: boolean) => void;
}) {
  const { t } = useTranslation();
  const { query, loadedAt } = data;
  const identityContext = { currentUserId, fallbackGroup: 'model' as const, userDimensionAvailable: true };
  const preferences = useUserPreferences();
  const [metric, setMetric] = useState<UsageMetric>('total');
  const [hidden, setHidden] = useState(new Set<string>());
  const [groupWas, setGroupWas] = useState(query.groupBy);
  if (groupWas !== query.groupBy) { setGroupWas(query.groupBy); setHidden(new Set()); }
  const upstreams = useMemo(() => [record], [record]);
  const dimensions = useMemo(() => usageDimensions({ usage: data.usage, upstreams, currentUserId, t })
    .filter(dimension => dimension.key !== 'upstream'), [currentUserId, data.usage, t, upstreams]);
  const chart = useMemo(() => {
    return {
      ...buildUpstreamMetricsChart(
        resolveUpstreamMetricDisplays(record, data.metrics.records, t, { quotaDisplay: preferences.quotaDisplay }),
        record,
      ), title: t('dashboard.upstreamTelemetry.metrics'),
    };
  }, [data.metrics, preferences.quotaDisplay, record, t]);
  return <LinkedChartHoverProvider><div className={`${PANEL_INSET_CLASS} ${PANEL_STACK_CLASS} min-w-0`} id={`upstream-telemetry-${encodeURIComponent(record.id)}`}>
    <div className="flex items-end gap-3 min-w-0 flex-wrap">
      <UsageGrouping disabled={busy} dimensions={dimensions} groupBy={query.groupBy} onChange={groupBy => onQueryChange({ ...query, ...changeTelemetryGroupBy(query, groupBy, identityContext) })} />
      <TelemetryFilterFields disabled={busy} dimensions={dimensions} filters={query.filters} groupBy={query.groupBy}
        onFilterChange={(key, values) => onQueryChange({ ...query, ...changeTelemetryFilter(query, key, values, identityContext) })}
        selectedLabel={count => t('dashboard.usage.filters.selected', { count })} />
      <div className="ml-auto flex-none" inert={busy}><TelemetryTimeRange addressOf={null} ariaLabel={t('dashboard.usage.range.label')} loadedAt={loadedAt}
        onChange={range => onQueryChange({ ...query, range })} onEditingChange={onRangeEditingChange} range={query.range} /></div>
    </div>
    <TokenUsageCharts usage={data.usage} dimensions={dimensions} upstreams={upstreams} groupBy={query.groupBy} range={query.range} loadedAt={loadedAt}
      metric={metric} onMetricChange={setMetric} hidden={hidden} onHiddenChange={setHidden} title={t('dashboard.upstreamTelemetry.usage')} />
    <UpstreamMetricsChartSection key={record.id} chart={chart} start={data.metrics.start} end={Math.min(data.metrics.end, loadedAt)} />
  </div></LinkedChartHoverProvider>;
}
