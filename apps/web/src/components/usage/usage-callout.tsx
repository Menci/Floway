import { bucketKeyForCallout, formatCount, formatDecimalCount, formatHitRate, formatInputRate, formatUsdCost, summarizeCounters } from './chart-model';
import type { CalloutPoint, UsageChartModel } from './types';
import { fluentComponents } from '../../fluent';
import { formatCalloutTitle } from '../charts/dashboard-time';
import { ScrollArea } from '../ui/scroll-area';

const { Text } = fluentComponents;

export function UsageChartCallout({ chart, labelByTime, locale, point, valueFormatter }: { chart: UsageChartModel; labelByTime: Map<number, string>; locale: string; point: CalloutPoint | null; valueFormatter: (value: number) => string }) {
  if (!point?.rows.length) return null;
  const bucketKey = bucketKeyForCallout(point.x, chart.buckets);
  const bucketDetails = bucketKey ? chart.details.get(bucketKey) : undefined;
  // Zero-height bar segments only preserve stack position. A line point at 0%
  // is a measured value and remains visible in its callout.
  const rows = (chart.plot.form === 'area' ? point.rows.filter(row => row.value > 0) : point.rows)
    .sort((a, b) => b.value - a.value);
  if (rows.length === 0) return null;
  return (
    <ScrollArea axes="horizontal" className="max-w-[min(760px,calc(100vw-48px))] min-w-[220px]" contentClassName="grid gap-[6px] p-1">
      <Text size={200} weight="semibold">
        {formatCalloutTitle(point.x, labelByTime, chart.range, locale)}
      </Text>
      {chart.kind === 'token' && bucketDetails ? (
        <table className="border-collapse whitespace-nowrap">
          <thead>
            <tr>
              <th className="max-w-[180px] min-w-[120px] pl-0 text-left" />
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Req</Text></th>
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Cost</Text></th>
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Total</Text></th>
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Cached</Text></th>
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Cached%</Text></th>
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Prefill</Text></th>
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Output</Text></th>
              <th className="px-2 py-[2px] text-right"><Text size={100} weight="semibold" className="text-fui-fg2">Hit%</Text></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(item => {
              const entry = chart.entries.find(candidate => candidate.label === item.legend);
              const counters = entry ? bucketDetails.get(entry.id) : undefined;
              if (!counters) return null;
              const summary = summarizeCounters(counters);
              return (
                <tr key={item.legend}>
                  <td className="max-w-[180px] min-w-[120px] pl-0 text-left">
                    <span className="flex items-center gap-[6px] min-w-0 overflow-hidden text-ellipsis">
                      <i className="rounded-[2px] h-[10px] w-[10px] flex-shrink-0" style={{ backgroundColor: item.color }} />
                      <Text size={200}>{item.legend}</Text>
                    </span>
                  </td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatCount(summary.requests, locale)}</Text></td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatUsdCost(summary.cost)}</Text></td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatDecimalCount(summary.total)}</Text></td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatDecimalCount(summary.cacheRead)}</Text></td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatInputRate(summary.cacheRead, summary.prompt)}</Text></td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatDecimalCount(summary.prefill)}</Text></td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatDecimalCount(summary.output)}</Text></td>
                  <td className="px-2 py-[2px] text-right"><Text size={200}>{formatHitRate(summary.cacheRead, summary.cacheCreation)}</Text></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        rows.map(item => (
          <Text key={item.legend} size={200} className="flex items-center gap-1.5 justify-between font-mono">
            <i className="rounded-full h-[8px] w-[8px] flex-shrink-0" style={{ backgroundColor: item.color }} />
            {item.legend}: {valueFormatter(item.value)}
          </Text>
        ))
      )}
    </ScrollArea>
  );
}
