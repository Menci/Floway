import { LineChart, type ChartProps, type CustomizedCalloutData } from '@fluentui/react-charts';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { PerformancePlot, PerformanceChartPointDetails } from './plot';
import { fluentComponents } from '../../fluent';
import { formatDuration } from '../../lib/format-duration';
import { formatTokenRate } from '../../lib/format-number';
import { useLocale } from '../../lib/use-locale';
import { ChartCalloutTable } from '../charts/chart-callout-table';
import { useUnclippedChartFrame } from '../charts/chart-frame-styles';
import { ChartSection } from '../charts/chart-section';
import { chartTickValues, formatAxisDate, formatCalloutTitle } from '../charts/dashboard-time';
import type { ChartSeries } from '../charts/series-legends';
import { useElementSize } from '../charts/use-element-size';
import { EmptyStateLine } from '../ui/empty-state';
import { ScrollArea } from '../ui/scroll-area';

const { makeStyles } = fluentComponents;

const chartMargins = { top: 16, right: 20, bottom: 42, left: 64 } as const;
// A log axis emits a tick per significant digit, so the sub-second decade alone
// printed 400ms/500ms/600ms/700ms/800ms/900ms/1.0s into the height of two
// labels — measured at 6px apart. `yAxisTickCount` is ignored on a log scale,
// so the ticks stay (they are the minor gridlines a log axis is read against)
// and only the labels thin out, to the 1/2/5 mantissas that are the convention
// for a labelled decade.
const LABELLED_LOG_MANTISSAS = [1, 2, 5];
const labelledOnLogAxis = (value: number): boolean => {
  if (!(value > 0)) return false;
  const mantissa = value / 10 ** Math.floor(Math.log10(value));
  return LABELLED_LOG_MANTISSAS.some(candidate => Math.abs(mantissa - candidate) < 0.01);
};
// WinUI ships no chart, so the marks inside the plot are read against Fluent's
// line chart rather than transcribed from a dictionary. What this layer settles
// is how large a data point is drawn and which of Fluent's hover affordances
// answers the pointer.
//
// A series here carries `mode: 'lines+markers'` over a monotone curve, which
// puts Fluent on its curve branch: the line is a single path, every point is a
// marker circle whose fill and stroke are both the series colour, and one
// highlight circle per series is parked offscreen and moved under the pointer.
// Radius and stroke width together give the dot its diameter -- 2px of radius
// inside a 1.5px stroke reads as 5.5px beside the 2px line -- and they hold in
// every state, because the pointer is answered at an x position rather than at
// one series' point.
//
// That answer is the vertical line plus a callout, and the callout is a table
// of every series at that x. Fluent's highlight circle singles one of them out,
// which would contradict the table standing next to it, so it is not painted.
// It has to lose its paint rather than its box: Fluent anchors the callout to
// this circle's bounding rect, which `visibility` leaves in place and `display`
// would collapse onto the plot's origin. A hidden element also takes no pointer
// input, so the markers and the line underneath keep theirs.
//
// The x axis draws its ticks at the plot's full height so that they double as
// gridlines, which lays a full-height stroke across every series. Hit testing
// has to pass through those strokes, or a pointer crossing one leaves the
// series beneath it unanswered.
//
// No rule here states a colour, so both colour schemes and a forced palette are
// left to Fluent, which paints the marks in the series colours the chart
// palette hands it.
const usePerformanceChartStyles = makeStyles({
  root: {
    '& .fui-cart__xAxis line': { pointerEvents: 'none' },
    '& circle:not([id*="staticHighlightCircle"])': { r: '2px !important', strokeWidth: '1.5px' },
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
  const chartRootStyles = useUnclippedChartFrame();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(host);
  const locale = useLocale();
  const formatter = chart.metric === 'ttft' ? formatDuration : formatTokenRate;
  const entryByLegend = useMemo(() => new Map(chart.entries.map(entry => [entry.legend, entry])), [chart.entries]);
  const visibleLegends = useMemo(() => new Set(chart.entries.filter(entry => !hidden.has(entry.id)).map(entry => entry.legend)), [chart.entries, hidden]);
  const visibleData = useMemo<ChartProps>(() => ({ ...chart.data, lineChartData: chart.data.lineChartData?.filter(series => visibleLegends.has(series.legend)) }), [chart.data, visibleLegends]);
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
  const plotHeight = Math.max(0, size.height - chartMargins.top - chartMargins.bottom);
  return <div className={`${chartStyles.root} h-[320px] min-w-0 w-full`} ref={setHost}>{size.width < 120 ? null : visibleData.lineChartData?.length ? <LineChart styles={chartRootStyles} customDateTimeFormatter={date => formatAxisDate(date, chart.range, locale)} data={visibleData} enablePerfOptimization height={size.height} hideLegend margins={chartMargins} onRenderCalloutPerStack={callout} tickValues={chartTickValues(chart.buckets).map(bucket => bucket.date)} width={size.width} xAxistickSize={-plotHeight} yAxisTickFormat={(value: number) => labelledOnLogAxis(value) ? formatter(value) : ''} yMaxValue={values.length ? Math.max(...values) : undefined} yMinValue={values.length ? Math.min(...values) : undefined} yScaleType="log" /> : <div className="grid h-full place-items-center"><EmptyStateLine>{t('dashboard.performance.empty')}</EmptyStateLine></div>}</div>;
}

function PerformanceChartCallout({ data, details, entryByLegend, title }: {
  data: CustomizedCalloutData;
  details: ReadonlyMap<string, PerformanceChartPointDetails> | undefined;
  entryByLegend: ReadonlyMap<string, ChartSeries>;
  title: string;
}) {
  const { t } = useTranslation();
  // A callout can outlive the data it described: the chart keeps its own hover
  // state across a range or metric switch and asks for a callout carrying
  // legends from the dataset that has just been replaced. Such a row no longer
  // exists, so it is dropped rather than substituted -- a table describing the
  // data must not name a series the data does not have.
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
