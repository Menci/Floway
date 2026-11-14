import { AreaChart, LineChart, type CustomizedCalloutData } from '@fluentui/react-charts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { hasUsageCallout, UsageChartCallout } from './callout';
import type { CalloutPoint, UsageChartModel } from './types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { AssumedChartHover } from '../charts/assumed-hover';
import { chartTickValues, formatAxisDate, type ChartBucket } from '../charts/dashboard-time';
import { useChartFrame } from '../charts/frame-styles';
import { ChartHost } from '../charts/host';
import { chartMargins, chartPlotWidth, chartTickCount } from '../charts/layout';
import { chartHoverPointer, LinkedChartAssumedHover, nearestChartPoint, useLinkedChartHover, type ChartHoverPointer } from '../charts/linked-hover';
import { FluentChartPointMarkers } from '../charts/point-markers';
import { visibleSeriesData } from '../charts/series-selection';

const { makeStyles } = fluentComponents;

// Distinct hues are how a multi-series plot is read, so the series paint is
// deliberately left in the UA's `forced-color-adjust: preserve-parent-color`
// for `svg`; only Fluent's axis text and gridlines opt back in.
// https://drafts.csswg.org/css-color-adjust-1/#forced-color-adjust-prop
const useAreaBoundaryStyles = makeStyles({
  root: {
    // Fluent fades a stacked area's own boundary to 0.3 at rest and restores it
    // only while the callout is open, redrawing every outline in the plot on
    // hover; the boundary separates one band from the next, so hold it at full
    // strength in every state.
    '& path[id*="-line-"]': { opacity: '1', strokeWidth: '2px' },
    // At Fluent's 0.7 two adjacent palette hues meet as near-solid blocks and
    // the boundary between them stops reading; 0.42 keeps each band a tint of
    // the surface it sits on, in either scheme.
    '& path[id*="-graph-"]': { fillOpacity: '0.42' },
  },
});

export function UsageChart({ chart, hidden, valueFormatter }: { chart: UsageChartModel; hidden: Set<string>; valueFormatter: (value: number) => string }) {
  const { t } = useTranslation();
  const areaBoundaryStyles = useAreaBoundaryStyles();
  const chartRootStyles = useChartFrame();
  const entryByLegend = useMemo(() => new Map(chart.entries.map(entry => [entry.legend, entry])), [chart.entries]);
  const visibleData = useMemo(() => visibleSeriesData(chart.entries, chart.plot.data, hidden), [chart.entries, chart.plot.data, hidden]);
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const { assumedHover, pointerStore, report } = useLinkedChartHover();
  const [realHover, setRealHover] = useState(false);
  const pointerRef = useRef<ChartHoverPointer | null>(null);
  const realBucketRef = useRef<ChartBucket | null>(null);
  const first = chart.buckets[0]?.date.getTime();
  const last = chart.buckets.at(-1)?.date.getTime();
  // A line form drops the buckets a series has no reading in, so the times the
  // plot can answer for are the ones its series actually carry.
  const plottedTimes = useMemo(() => [...new Set(visibleData.lineChartData?.flatMap(series =>
    series.data.flatMap(point => point.x instanceof Date ? [point.x.getTime()] : [])) ?? [])].sort((left, right) => left - right), [visibleData]);
  const pointAt = useCallback((xRatio: number) => {
    if (first === undefined || last === undefined) return null;
    return nearestChartPoint(plottedTimes, first + xRatio * (last - first), candidate => candidate);
  }, [first, last, plottedTimes]);
  const positionOf = useCallback((time: number) => first === undefined || last === undefined || first === last ? null : (time - first) / (last - first), [first, last]);

  const renderCallout = useCallback((point: CalloutPoint | null) => (
    <UsageChartCallout chart={chart} labelByTime={labelByTime} point={point} valueFormatter={valueFormatter} />
  ), [chart, labelByTime, valueFormatter]);

  // The chart keeps its own hover state across a query switch, so it
  // can ask for a callout carrying legends from the dataset it just replaced.
  // Such a row is dropped rather than substituted -- a table describing the
  // data must not name a series the data does not have.
  const reportRealHover = useCallback((bucket: ChartBucket | null) => {
    realBucketRef.current = bucket;
    setRealHover(bucket !== null);
    if (bucket === null) {
      report(null);
      return;
    }
    // The reported position must be one this plot reads back as the point on
    // screen, which a pointer left behind by the mouse is not once a keyboard
    // focus moves the hover elsewhere.
    const timestamp = bucket.date.getTime();
    const retained = pointerRef.current !== null && pointAt(pointerRef.current.xRatio) === timestamp ? pointerRef.current : null;
    const position = positionOf(timestamp);
    report(retained ?? (position === null ? null : { xRatio: position, yRatio: 0.5 }));
  }, [pointAt, positionOf, report]);

  const lineCallout = useCallback((data?: CustomizedCalloutData) => {
    if (!data) return null;
    const point = {
      x: data.x,
      rows: data.values.flatMap(value => {
        const entry = entryByLegend.get(value.legend);
        return entry ? [{ id: entry.id, label: entry.label, color: value.color, value: Number(value.y) }] : [];
      }),
    };
    const timestamp = data.x instanceof Date ? data.x.getTime() : Number(data.x);
    const bucket = chart.buckets.find(candidate => candidate.date.getTime() === timestamp);
    return bucket && hasUsageCallout(chart, point)
      ? <UsageRealHover bucket={bucket} onChange={reportRealHover}>{renderCallout(point)}</UsageRealHover>
      : renderCallout(point);
  }, [chart, entryByLegend, renderCallout, reportRealHover]);

  const hasData = visibleData.lineChartData?.some(series => series.data.length > 0) ?? false;

  return (
    <ChartHost className={areaBoundaryStyles.root} emptyText={t('dashboard.usage.empty')} hasData={hasData}
      onMouseEnter={() => setRealHover(true)} onMouseLeave={() => { pointerRef.current = null; reportRealHover(null); }}
      onMouseMove={event => {
        const pointer = chartHoverPointer(event.currentTarget, event.clientX, event.clientY);
        pointerRef.current = pointer;
        if (realBucketRef.current !== null) report(pointer);
      }}>
      {({ element, size }) => {
        const tickCount = chartTickCount(chartPlotWidth(size.width), chart.buckets.length <= 24 ? 6 : 7);
        const tickValues = chartTickValues(chart.buckets, tickCount).map(bucket => bucket.date);

        const renderedChart = chart.plot.form === 'area' ? (
          <StackedAreaChart
            customDateTimeFormatter={formatAxisDate}
            data={visibleData}
            element={element}
            enablePerfOptimization
            height={size.height}
            hideLegend
            margins={chartMargins}
            mode="tonexty"
            onRenderCalloutPerStack={lineCallout}
            styles={chartRootStyles}
            tickValues={tickValues}
            width={size.width}
            yAxisTickFormat={valueFormatter}
            yMinValue={0}
          />
        ) : (
          <LineChart
            customDateTimeFormatter={formatAxisDate}
            data={visibleData}
            enablePerfOptimization
            height={size.height}
            hideLegend
            margins={chartMargins}
            onRenderCalloutPerStack={lineCallout}
            styles={chartRootStyles}
            tickValues={tickValues}
            width={size.width}
            yAxisTickFormat={valueFormatter}
            yMaxValue={100}
            yMinValue={0}
          />
        );
        const assumedCallout = (assumed: ChartBucket) => {
          if (realHover || first === undefined || last === undefined) return null;
          const timestamp = assumed.date.getTime();
          const point = {
            x: assumed.date,
            rows: visibleData.lineChartData?.flatMap(series => {
              const entry = entryByLegend.get(series.legend);
              const value = series.data.find(candidate => candidate.x instanceof Date && candidate.x.getTime() === timestamp);
              return entry && value ? [{ id: entry.id, label: entry.label, color: series.color!, value: Number(value.y) }] : [];
            }) ?? [],
          };
          const callout = hasUsageCallout(chart, point) ? renderCallout(point) : null;
          const x = chartMargins.left + (last === first ? 0.5 : (timestamp - first) / (last - first)) * chartPlotWidth(size.width);
          return <AssumedChartHover bottom={chartMargins.bottom} element={element} pointerStore={pointerStore} top={chartMargins.top} x={x}>
            {callout}
          </AssumedChartHover>;
        };
        return <>
          {renderedChart}
          <FluentChartPointMarkers data={visibleData} element={element} form={chart.plot.form} />
          <LinkedChartAssumedHover hover={assumedHover} resolve={pointer => {
            const nearest = pointAt(pointer.xRatio);
            return nearest === null ? null : chart.buckets.find(bucket => bucket.date.getTime() === nearest) ?? null;
          }}>{assumedCallout}</LinkedChartAssumedHover>
        </>;
      }}
    </ChartHost>
  );
}

function UsageRealHover({ bucket, children, onChange }: {
  bucket: ChartBucket;
  children: ReactNode;
  onChange: (bucket: ChartBucket | null) => void;
}) {
  useEffect(() => {
    onChange(bucket);
  }, [bucket, onChange]);
  return children;
}

// Fluent emits each stacked band right after its own boundary line, and the
// band's top edge is that line, so every band paints over the stroke it was
// meant to be capped by. Moving the lines to the end of the series group is the
// paint order the boundary rule above assumes, and it is why this form takes the
// host element: the reorder is driven by the mutations it repairs rather than by
// a render or a frame tick, so each re-emission of the group is answered before
// the browser paints it.
function StackedAreaChart({ element, ...chartProps }: { element: HTMLElement } & ComponentProps<typeof AreaChart>) {
  useLayoutEffect(() => {
    const raiseBoundaries = () => {
      const lines = [...element.querySelectorAll<SVGPathElement>('path[id*="-line-"]')];
      const group = lines[0]?.parentElement;
      if (!group) return;
      // Sorting by the series index the id carries is the fixed point: appending
      // the lines in the order they are found reverses them on every pass, which
      // flips which colour wins wherever two boundaries coincide. The lowest
      // series ends up last and stays on top however this pass finds them.
      const raised = lines.toSorted((a, b) => Number.parseInt(b.id, 10) - Number.parseInt(a.id, 10));
      // The observer sees its own appends, so a pass with nothing to do moves
      // nothing at all.
      const tail = [...group.children].slice(-raised.length);
      if (tail.every((node, index) => node === raised[index])) return;
      for (const line of raised) group.append(line);
    };
    raiseBoundaries();
    const observer = new MutationObserver(raiseBoundaries);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [element]);

  return <AreaChart {...chartProps} />;
}
