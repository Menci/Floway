import { useMemo } from 'react';

import { UsageChartSection } from './chart-section';
import { formatMetricValue } from './format';
import { buildTokenChart, dashboardBuckets, summarizeUsage } from './plot';
import { SummaryMetrics } from './summary-metrics';
import type { UsageGroupBy, UsageMetric, UsageOverviewResponse, UsageRange, UsageUpstream } from './types';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
import type { TelemetryDimension } from '../telemetry/dimension-controls';
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
  const selected = dimensions?.find(dimension => dimension.key === groupBy);
  if (dimensions !== null && selected === undefined) throw new RangeError(`Unknown Usage grouping dimension: ${groupBy}`);
  const model = useMemo(() => {
    if (usage === null || selected === undefined) return null;
    const visible = usage.series.filter(record => !hidden.has(record.group));
    return {
      summary: summarizeUsage(hidden.size === 0 ? usage.axes.none : visible),
      chart: buildTokenChart({
        records: usage.series, dimensionOptions: selected.options, metric, range, buckets: dashboardBuckets(range, loadedAt),
        seriesHues: groupBy === 'upstream' ? new Map(upstreams.map(upstream => [usageUpstreamDimensionValue(upstream.id), upstream.hue])) : undefined,
      }),
    };
  }, [groupBy, hidden, loadedAt, metric, range, selected, upstreams, usage]);
  if (model === null || selected === undefined) return <EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine>;
  return <>
    <UsageChartSection chart={model.chart} detailsLabel={selected.groupLabel} hidden={hidden} onHiddenChange={onHiddenChange}
      title={title ?? selected.groupLabel} valueFormatter={value => formatMetricValue(value, metric, locale)} />
    <SummaryMetrics metric={metric} onMetricChange={onMetricChange} summary={model.summary} />
  </>;
}
