import { useTranslation } from 'react-i18next';

import { bucketKeyForCallout, formatCompactDecimalCount, formatCount, formatHitRate, formatInputRate, formatUsdCost, summarizeCounters } from './chart-model';
import type { CalloutPoint, UsageChartModel } from './types';
import { fluentComponents } from '../../fluent';
import { formatCalloutTitle } from '../charts/dashboard-time';
import { ScrollArea } from '../ui/scroll-area';

const { Text } = fluentComponents;

export function UsageChartCallout({ chart, labelByTime, locale, point, valueFormatter }: { chart: UsageChartModel; labelByTime: Map<number, string>; locale: string; point: CalloutPoint | null; valueFormatter: (value: number) => string }) {
  const { t } = useTranslation();
  if (!point?.rows.length) return null;
  const bucketKey = bucketKeyForCallout(point.x, chart.buckets);
  const bucketDetails = chart.kind === 'token' && bucketKey ? chart.details.get(bucketKey) : undefined;
  // Zero-height bar segments only preserve stack position. A line point at 0%
  // is a measured value and remains visible in its callout.
  const rows = (chart.plot.form === 'area' ? point.rows.filter(row => row.value > 0) : point.rows)
    .sort((a, b) => b.value - a.value);
  if (rows.length === 0) return null;
  return (
    <ScrollArea axes="horizontal" className="max-w-[min(650px,calc(100vw-48px))] min-w-[220px]" contentClassName="grid gap-1">
      {chart.kind === 'token' && bucketDetails ? (
        <table className="border-collapse leading-[1.15] whitespace-nowrap [&_td]:!py-0 [&_th]:!py-0">
          <thead>
            <tr>
              <th className="max-w-[180px] min-w-[120px] pl-0 text-left"><Text size={100} weight="semibold" className="text-fui-fg2">{formatCalloutTitle(point.x, labelByTime, chart.range, locale)}</Text></th>
              {(['requests', 'cost', 'total', 'cached', 'cachedRate', 'prefill', 'output', 'hitRate'] as const).map(label => <th className="px-1.5 py-px text-right" key={label}><Text size={100} weight="semibold" className="text-fui-fg2">{t(`dashboard.usage.callout.${label}`)}</Text></th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(item => {
              const entry = chart.entries.find(candidate => candidate.id === item.id);
              const counters = entry ? bucketDetails.get(entry.id) : undefined;
              if (!counters) return null;
              const summary = summarizeCounters(counters);
              return (
                <tr key={item.id}>
                  <td className="max-w-[180px] min-w-[120px] pl-0 text-left">
                    <span className="flex items-center gap-[6px] min-w-0 overflow-hidden text-ellipsis">
                      <i className="rounded-[2px] h-[10px] w-[10px] flex-shrink-0" style={{ backgroundColor: item.color }} />
                      <Text size={100}>{item.label}</Text>
                    </span>
                  </td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatCount(summary.requests, locale)}</Text></td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatUsdCost(summary.cost)}</Text></td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatCompactDecimalCount(summary.total, locale)}</Text></td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatCompactDecimalCount(summary.cacheRead, locale)}</Text></td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatInputRate(summary.cacheRead, summary.prompt)}</Text></td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatCompactDecimalCount(summary.prefill, locale)}</Text></td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatCompactDecimalCount(summary.output, locale)}</Text></td>
                  <td className="px-1.5 py-px text-right"><Text size={100}>{formatHitRate(summary.cacheRead, summary.cacheCreation)}</Text></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <>
          <Text size={200} weight="semibold">{formatCalloutTitle(point.x, labelByTime, chart.range, locale)}</Text>
          {rows.map(item => (
            <Text key={item.id} size={100} className="flex items-center gap-1.5 justify-between tabular-nums">
              <i className="rounded-full h-[8px] w-[8px] flex-shrink-0" style={{ backgroundColor: item.color }} />
              {item.label}: {valueFormatter(item.value)}
            </Text>
          ))}
        </>
      )}
    </ScrollArea>
  );
}
