import { formatCompactDecimalCount, formatRatePercent } from './format';
import { bucketKeyForCallout, summarizeCounters } from './plot';
import type { CalloutPoint, UsageChartModel } from './types';
import { useTranslation } from '../../i18n/translation';
import { formatUsd } from '../../lib/decimal-display';
import { formatCount } from '../../lib/format-number';
import { useLocale } from '../../lib/use-locale';
import { ChartCalloutTable } from '../charts/callout-table';
import { formatCalloutTitle } from '../charts/dashboard-time';
import { ScrollArea } from '../ui/scroll-area';

export function UsageChartCallout({ chart, labelByTime, point, valueFormatter }: { chart: UsageChartModel; labelByTime: Map<number, string>; point: CalloutPoint | null; valueFormatter: (value: number) => string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (!point?.rows.length) return null;
  const bucketKey = bucketKeyForCallout(point.x, chart.buckets);
  const bucketDetails = chart.kind === 'token' && bucketKey ? chart.details.get(bucketKey) : undefined;
  // Zero-height bar segments only preserve stack position. A line point at 0%
  // is a measured value and remains visible in its callout.
  const rows = (chart.plot.form === 'area' ? point.rows.filter(row => row.value > 0) : point.rows)
    .sort((a, b) => b.value - a.value);
  if (rows.length === 0) return null;
  const title = formatCalloutTitle(point.x, labelByTime, chart.range, locale);
  return (
    <ScrollArea axes="horizontal" className="max-w-[min(650px,calc(100vw-48px))] min-w-[220px]" contentClassName="grid gap-1">
      {chart.kind === 'token' && bucketDetails ? (
        <ChartCalloutTable
          columns={(['requests', 'cost', 'total', 'cached', 'cachedRate', 'prefill', 'output', 'hitRate'] as const).map(key => ({ key, label: t(`dashboard.usage.callout.${key}`) }))}
          rows={rows.flatMap(item => {
            const counters = bucketDetails.get(item.id);
            if (!counters) return [];
            const summary = summarizeCounters(counters);
            return [{
              color: item.color,
              key: item.id,
              label: item.label,
              values: [formatCount(summary.requests, locale), formatUsd(summary.cost), formatCompactDecimalCount(summary.total, locale), formatCompactDecimalCount(summary.cacheRead, locale), formatRatePercent(summary.cachedRate), formatCompactDecimalCount(summary.prefill, locale), formatCompactDecimalCount(summary.output, locale), formatRatePercent(summary.cacheHitRate)],
            }];
          })}
          title={title}
        />
      ) : (
        <ChartCalloutTable
          columns={[{ key: 'requests', label: t('dashboard.usage.callout.requests') }]}
          rows={rows.map(item => ({ color: item.color, key: item.id, label: item.label, values: [valueFormatter(item.value)] }))}
          title={title}
        />
      )}
    </ScrollArea>
  );
}
