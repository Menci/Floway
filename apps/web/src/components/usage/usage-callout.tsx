import type { CustomizedCalloutData } from "@fluentui/react-charts";
import { fluentComponents } from "../../fluent";
import { bucketKeyForCallout, formatCalloutTitle, formatCost, formatCount, formatHitRate, formatInputRate, formatTokenCount } from "./chart-model";
import type { UsageChartModel } from "./types";

const { Text } = fluentComponents;

export function UsageChartCallout({ chart, data, labelByTime, locale, valueFormatter }: { chart: UsageChartModel; data?: CustomizedCalloutData; labelByTime: Map<number, string>; locale: string; valueFormatter: (value: number) => string }) {
  if (!data?.values.length) return null;
  const bucketKey = bucketKeyForCallout(data.x, chart.buckets);
  const bucketDetails = bucketKey ? chart.details.get(bucketKey) : undefined;
  const rows = data.values.filter((item) => item.y > 0).sort((a, b) => b.y - a.y);
  return (
    <div className="grid gap-[6px] max-w-[min(760px,calc(100vw-48px))] min-w-[220px] overflow-x-auto p-1">
          <Text size={200} weight="semibold">
            {formatCalloutTitle(data.x, labelByTime, chart.range, locale)}
          </Text>
          {chart.kind === "token" && bucketDetails ? (
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
                {rows.map((item) => {
                  const entry = chart.entries.find((candidate) => candidate.label === item.legend);
                  const detail = entry ? bucketDetails.get(entry.id) : undefined;
                  if (!detail) return null;
                  const prompt =
                    detail.input +
                    detail.cacheRead +
                    detail.cacheCreation +
                    detail.inputImage;
                  const output = detail.output + detail.outputImage;
                  const total = prompt + output;
                  const prefill = detail.input + detail.cacheCreation + detail.inputImage;
                  return (
                    <tr key={item.legend}>
                      <td className="max-w-[180px] min-w-[120px] pl-0 text-left">
                        <span className="flex items-center gap-[6px] min-w-0 overflow-hidden text-ellipsis">
                          <i className="rounded-[2px] h-[10px] w-[10px] flex-shrink-0" style={{ backgroundColor: item.color }} />
                          <Text size={200}>{item.legend}</Text>
                        </span>
                      </td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatCount(detail.requests, locale)}</Text></td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatCost(detail.cost)}</Text></td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatTokenCount(total, locale)}</Text></td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatTokenCount(detail.cacheRead, locale)}</Text></td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatInputRate(detail.cacheRead, prompt)}</Text></td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatTokenCount(prefill, locale)}</Text></td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatTokenCount(output, locale)}</Text></td>
                      <td className="px-2 py-[2px] text-right"><Text size={200}>{formatHitRate(detail.cacheRead, detail.cacheCreation)}</Text></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            rows.map((item) => (
              <Text key={item.legend} size={200} className="flex items-center gap-1.5 justify-between font-mono">
                <i className="rounded-full h-[8px] w-[8px] flex-shrink-0" style={{ backgroundColor: item.color }} />
                {item.legend}: {valueFormatter(item.y)}
              </Text>
            ))
          )}
    </div>
  );
}
