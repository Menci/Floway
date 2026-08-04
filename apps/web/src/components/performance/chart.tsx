import { LineChart, type CustomizedCalloutData } from '@fluentui/react-charts';
import { useCallback, useMemo } from 'react';
import type { ReactElement } from 'react';

import type { PerformancePlot, PerformanceChartPointDetails } from './plot';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { formatTokenRate } from '../../lib/format-number';
import { useLocale } from '../../lib/use-locale';
import { ChartCalloutTable } from '../charts/callout-table';
import { chartTickValues, formatAxisDate, formatCalloutTitle } from '../charts/dashboard-time';
import { useChartFrame } from '../charts/frame-styles';
import { ChartHost } from '../charts/host';
import { ChartSection } from '../charts/section';
import type { ChartSeries } from '../charts/series-legends';
import { visibleSeriesData } from '../charts/series-selection';
import { ScrollArea } from '../ui/scroll-area';

const { makeStyles } = fluentComponents;

const chartMargins = { top: 16, right: 20, bottom: 42, left: 64 } as const;
// `yAxisTickCount` is ignored on a log scale, so labels thin out instead of
// ticks: every significant digit stays a gridline, only 1/2/5 gets a label.
const LABELLED_LOG_MANTISSAS = [1, 2, 5];
const labelledOnLogAxis = (value: number): boolean => {
  if (!(value > 0)) return false;
  const mantissa = value / 10 ** Math.floor(Math.log10(value));
  return LABELLED_LOG_MANTISSAS.some(candidate => Math.abs(mantissa - candidate) < 0.01);
};
// The per-series highlight circle would contradict the callout table, so it
// loses its paint rather than its box: Fluent anchors the callout to that
// circle's bounding rect, which `display` would collapse onto the origin. The
// marker sizing in the shared chart frame holds in every state, because the
// pointer is answered at an x position rather than at one series' point.
//
// The x axis draws its ticks at the plot's full height so they double as
// gridlines, so hit testing has to pass through them or a pointer crossing one
// leaves the series beneath unanswered.
const usePerformanceChartStyles = makeStyles({
  root: {
    '& .fui-cart__xAxis line': { pointerEvents: 'none' },
    '& circle[id*="staticHighlightCircle"]': { visibility: 'hidden' },
  },
});
export function PerformanceChartSection({ chart, hidden, onHiddenChange, title }: { chart: PerformancePlot; hidden: Set<string>; onHiddenChange: (next: Set<string>) => void; title: string }) {
  const { t } = useTranslation();
  return <ChartSection controlsLabel={t('dashboard.performance.series.label')} emptyText={t('dashboard.performance.empty')} entries={chart.entries} hidden={hidden} onHiddenChange={onHiddenChange} title={title}>
    <PerformanceChart chart={chart} hidden={hidden} />
  </ChartSection>;
}

function PerformanceChart({ chart, hidden }: { chart: PerformancePlot; hidden: Set<string> }) {
  const { t } = useTranslation();
  const chartStyles = usePerformanceChartStyles();
  const chartRootStyles = useChartFrame();
  const locale = useLocale();
  const formatter = chart.metric === 'ttft' ? formatDuration : formatTokenRate;
  const entryByLegend = useMemo(() => new Map(chart.entries.map(entry => [entry.legend, entry])), [chart.entries]);
  const visibleData = useMemo(() => visibleSeriesData(chart.entries, chart.data, hidden), [chart.data, chart.entries, hidden]);
  const values = visibleData.lineChartData?.flatMap(series => series.data.map(point => point.y).filter((value): value is number => typeof value === 'number' && value > 0)) ?? [];
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const callout = useCallback((props?: CustomizedCalloutData): ReactElement | null => !props?.values.length
    ? null
    : <PerformanceChartCallout
        data={props}
        details={chart.details.get(props.x instanceof Date ? props.x.getTime() : Number(props.x))}
        entryByLegend={entryByLegend}
        title={formatCalloutTitle(props.x, labelByTime, chart.range, locale)}
      />, [chart.details, chart.range, entryByLegend, labelByTime, locale]);

  return <ChartHost className={chartStyles.root} emptyText={t('dashboard.performance.empty')} hasData={Boolean(visibleData.lineChartData?.length)}>
    {({ size }) => <LineChart styles={chartRootStyles} customDateTimeFormatter={date => formatAxisDate(date, chart.range, locale)} data={visibleData} enablePerfOptimization height={size.height} hideLegend margins={chartMargins} onRenderCalloutPerStack={callout} tickValues={chartTickValues(chart.buckets).map(bucket => bucket.date)} width={size.width} xAxistickSize={-Math.max(0, size.height - chartMargins.top - chartMargins.bottom)} yAxisTickFormat={(value: number) => labelledOnLogAxis(value) ? formatter(value) : ''} yMaxValue={values.length ? Math.max(...values) : undefined} yMinValue={values.length ? Math.min(...values) : undefined} yScaleType="log" />}
  </ChartHost>;
}

function PerformanceChartCallout({ data, details, entryByLegend, title }: {
  data: CustomizedCalloutData;
  details: ReadonlyMap<string, PerformanceChartPointDetails> | undefined;
  entryByLegend: ReadonlyMap<string, ChartSeries>;
  title: string;
}) {
  const { t } = useTranslation();
  // The chart keeps its hover state across a range or metric switch and can ask
  // for a callout carrying legends from the replaced dataset; such a row is
  // dropped rather than substituted.
  const rows = data.values
    .filter(item => item.y > 0)
    .toSorted((left, right) => right.y - left.y)
    .flatMap(item => {
      const entry = entryByLegend.get(item.legend);
      if (!entry) return [];
      const point = details?.get(entry.id);
      return [{
        color: item.color,
        key: entry.id,
        label: entry.label,
        values: [formatDuration(point?.ttft ?? null), formatTokenRate(point?.outputSpeed ?? null)],
      }];
    });

  if (rows.length === 0) return null;

  return (
    <ScrollArea axes="horizontal" className="max-w-[min(420px,calc(100vw-48px))] min-w-[300px]" contentClassName="grid gap-1">
      <ChartCalloutTable
        columns={[
          { key: 'ttft', label: t('dashboard.performance.metric.ttft') },
          { key: 'outputSpeed', label: t('dashboard.performance.metric.outputSpeed') },
        ]}
        rows={rows}
        title={title}
      />
    </ScrollArea>
  );
}
