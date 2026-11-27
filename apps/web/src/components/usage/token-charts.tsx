import { GroupDismissRegular, GroupRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';

import { UsageChartSection } from './chart-section';
import { formatMetricValue } from './format';
import { foldModelSeries, OTHER_SERIES_ID } from './model-groups';
import { ModelGroupsDialog } from './model-groups-dialog';
import { buildTokenChart, summarizeUsage } from './plot';
import { SummaryMetrics } from './summary-metrics';
import type { UsageGroupBy, UsageMetric, UsageOverviewResponse, UsageRange, UsageUpstream } from './types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
import { useUserPreferences } from '../../lib/use-preferences';
import { dashboardChartBuckets } from '../charts/dashboard-time';
import type { TelemetryDimension } from '../telemetry/dimension-controls';
import { EmptyStateLine } from '../ui/empty-state';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { usageUpstreamDimensionValue } from '@floway-dev/protocols/browser';

const { ToolbarButton, Tooltip } = fluentComponents;

export function TokenUsageCharts({ usage, dimensions, upstreams, groupBy, range, loadedAt, metric, onMetricChange, hidden, onHiddenChange, ungrouped, onUngroupedChange, title }: {
  usage: UsageOverviewResponse | null;
  dimensions: readonly TelemetryDimension<UsageGroupBy>[] | null;
  upstreams: readonly UsageUpstream[];
  groupBy: UsageGroupBy;
  range: UsageRange;
  loadedAt: number;
  metric: UsageMetric;
  onMetricChange: (next: UsageMetric) => void;
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
  /** Shows every model as its own series, setting the user's model groups aside. */
  ungrouped: boolean;
  onUngroupedChange: (next: boolean) => void;
  title: string | null;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { usageModelGroups, usageOtherShare } = useUserPreferences();
  const groupsDialog = useDialogInvocation<void>();
  const selected = dimensions?.find(dimension => dimension.key === groupBy);
  if (dimensions !== null && selected === undefined) throw new RangeError(`Unknown Usage grouping dimension: ${groupBy}`);
  const groupingConfigured = usageModelGroups.length > 0 || usageOtherShare > 0;
  const grouping = groupBy === 'model' && groupingConfigured && !ungrouped;
  const presentModels = useMemo(() => {
    if (usage === null || groupBy !== 'model') return [];
    const present = new Set(usage.series.map(record => record.group));
    return usage.dimensionValues.models.filter(model => present.has(model));
  }, [groupBy, usage]);
  const model = useMemo(() => {
    if (usage === null || selected === undefined) return null;
    const folded = grouping
      ? foldModelSeries({
          records: usage.series, models: usage.dimensionValues.models, groups: usageModelGroups, otherShare: usageOtherShare, metric,
          otherLabel: count => t('monitoring.usage.modelGroups.other.series', { count }),
        })
      : null;
    const records = folded?.records ?? usage.series;
    const visible = records.filter(record => !hidden.has(record.group));
    const chart = buildTokenChart({
      records, dimensionOptions: folded?.options ?? selected.options, metric, range, buckets: dashboardChartBuckets(range, loadedAt),
      seriesHues: groupBy === 'upstream' ? new Map(upstreams.map(upstream => [usageUpstreamDimensionValue(upstream.id), upstream.hue])) : undefined,
    });
    return {
      summary: summarizeUsage(hidden.size === 0 ? usage.axes.none : visible),
      chart: folded === null ? chart : {
        ...chart,
        entries: chart.entries.map(entry => ({ ...entry, members: folded.members.get(entry.id), pinnedLast: entry.id === OTHER_SERIES_ID })),
      },
    };
  }, [groupBy, grouping, hidden, loadedAt, metric, range, selected, t, upstreams, usage, usageModelGroups, usageOtherShare]);
  if (model === null || selected === undefined) return <EmptyStateLine>{t('common.errors.viewUnavailable')}</EmptyStateLine>;

  // A series id means a model in one view and a group in the other, so a
  // selection made in one is cleared rather than carried into the other.
  const toggleUngrouped = () => { onHiddenChange(new Set()); onUngroupedChange(!ungrouped); };
  const ungroupedLabel = ungrouped ? t('monitoring.usage.modelGroups.showGrouped') : t('monitoring.usage.modelGroups.showUngrouped');
  const actions = groupBy !== 'model' ? undefined : <>
    {groupingConfigured && <Tooltip content={ungroupedLabel} relationship="label">
      <ToolbarButton aria-label={ungroupedLabel} aria-pressed={ungrouped} icon={<GroupDismissRegular />} onClick={toggleUngrouped} />
    </Tooltip>}
    <Tooltip content={t('monitoring.usage.modelGroups.edit')} relationship="label">
      <ToolbarButton aria-label={t('monitoring.usage.modelGroups.edit')} icon={<GroupRegular />} onClick={() => groupsDialog.open()} />
    </Tooltip>
  </>;
  return <>
    <UsageChartSection actions={actions} chart={model.chart} detailsLabel={selected.groupLabel} hidden={hidden} onHiddenChange={onHiddenChange}
      title={title ?? selected.groupLabel} valueFormatter={value => formatMetricValue(value, metric, locale)} />
    <SummaryMetrics metric={metric} onMetricChange={onMetricChange} summary={model.summary} />
    {groupsDialog.invocation && <ModelGroupsDialog key={groupsDialog.invocation.key} models={presentModels} open={groupsDialog.isOpen}
      onOpenChange={open => { if (!open) groupsDialog.close(); }} />}
  </>;
}
