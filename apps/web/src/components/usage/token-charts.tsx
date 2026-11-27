import { useMemo } from 'react';

import { UsageChartSection } from './chart-section';
import { formatMetricValue } from './format';
import { buildTokenChart, summarizeUsage, usageRecordMetricWeight } from './plot';
import { SummaryMetrics } from './summary-metrics';
import type { DisplayUsageRecord, UsageGroupBy, UsageMetric, UsageOverviewResponse, UsageRange, UsageUpstream } from './types';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
import { useUserPreferences } from '../../lib/use-preferences';
import { dashboardChartBuckets } from '../charts/dashboard-time';
import { OTHER_SERIES_COLOR } from '../charts/palette';
import { OTHER_SERIES_ID, otherSeriesGroup, partitionSeriesForOther, stableSeriesHues } from '../charts/series-grouping';
import type { TelemetryDimension } from '../telemetry/dimension-controls';
import { TelemetryDisplayOptionsMenu } from '../telemetry/display-options-menu';
import { EmptyStateLine } from '../ui/empty-state';
import { usageUpstreamDimensionValue } from '@floway-dev/protocols/browser';

export function TokenUsageCharts({ usage, dimensions, upstreams, groupBy, range, loadedAt, metric, onMetricChange, hidden, onHiddenChange, title }: {
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
  title: string | null;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { foldSmallSeries } = useUserPreferences();
  const selected = dimensions?.find(dimension => dimension.key === groupBy);
  if (dimensions !== null && selected === undefined) throw new RangeError(`Unknown Usage grouping dimension: ${groupBy}`);
  const model = useMemo(() => {
    if (usage === null || selected === undefined) return null;
    const buckets = dashboardChartBuckets(range, loadedAt);
    const bucketKeys = new Set(buckets.map(bucket => bucket.key));
    const presentGroups = new Set(usage.series.map(record => record.group));

    const baselineWeights = new Map<string, number>();
    for (const record of usage.series) {
      if (!bucketKeys.has(record.bucket)) continue;
      baselineWeights.set(record.group, (baselineWeights.get(record.group) ?? 0) + usageRecordMetricWeight(record, 'total'));
    }
    const items = selected.options
      .filter(option => presentGroups.has(option.value))
      .map(option => ({ id: option.value, label: option.label }));

    const activeWeights = metric === 'total' ? baselineWeights : new Map<string, number>();
    if (metric !== 'total') {
      for (const record of usage.series) {
        if (!bucketKeys.has(record.bucket)) continue;
        activeWeights.set(record.group, (activeWeights.get(record.group) ?? 0) + usageRecordMetricWeight(record, metric));
      }
    }

    const explicitHues = groupBy === 'upstream'
      ? new Map(upstreams.map(upstream => [usageUpstreamDimensionValue(upstream.id), upstream.hue]))
      : undefined;
    const seriesHues = stableSeriesHues(items.map(item => item.id), baselineWeights, explicitHues);
    const { top, other: otherItems } = partitionSeriesForOther(items, activeWeights, foldSmallSeries);
    const otherIdSet = new Set(otherItems.map(item => item.id));

    const plotRecords: DisplayUsageRecord[] = [];
    for (const record of usage.series) {
      if (otherIdSet.has(record.group)) {
        if (!hidden.has(record.group)) plotRecords.push({ ...record, group: OTHER_SERIES_ID });
      } else {
        plotRecords.push(record);
      }
    }

    const topSet = new Set(top.map(item => item.id));
    // Preserve the metric-independent dimension order for stacking so switching
    // metrics reorders the legend without shuffling stacked area bands.
    const orderedTop = items.filter(item => topSet.has(item.id));
    const plotOptions = [
      ...orderedTop.map(item => ({ value: item.id, label: item.label })),
      ...(otherItems.length > 0 ? [{ value: OTHER_SERIES_ID, label: t('monitoring.charts.series.other') }] : []),
    ];
    const seriesColors = otherItems.length > 0 ? new Map([[OTHER_SERIES_ID, OTHER_SERIES_COLOR]]) : undefined;

    const chart = buildTokenChart({
      records: plotRecords,
      dimensionOptions: plotOptions,
      metric,
      range,
      buckets,
      seriesHues,
      seriesColors,
      seriesWeights: activeWeights,
    });

    const summaryRecords = hidden.size === 0
      ? usage.axes.none
      : usage.series.filter(record => !hidden.has(record.group));

    return {
      summary: summarizeUsage(summaryRecords),
      chart,
      other: otherSeriesGroup(otherItems),
    };
  }, [foldSmallSeries, groupBy, hidden, loadedAt, metric, range, selected, t, upstreams, usage]);

  if (model === null || selected === undefined) return <EmptyStateLine>{t('common.errors.viewUnavailable')}</EmptyStateLine>;
  return <>
    <UsageChartSection
      actions={<TelemetryDisplayOptionsMenu />}
      chart={model.chart}
      detailsLabel={selected.groupLabel}
      hidden={hidden}
      onHiddenChange={onHiddenChange}
      other={model.other}
      title={title ?? selected.groupLabel}
      valueFormatter={value => formatMetricValue(value, metric, locale)}
    />
    <SummaryMetrics metric={metric} onMetricChange={onMetricChange} summary={model.summary} />
  </>;
}
