import { AreaChart, LineChart, type CustomizedCalloutData } from '@fluentui/react-charts';
import { useCallback, useLayoutEffect, useMemo, type ComponentProps } from 'react';

import { UsageChartCallout } from './callout';
import type { CalloutPoint, UsageChartModel } from './types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
import { chartTickValues, formatAxisDate } from '../charts/dashboard-time';
import { useChartFrame } from '../charts/frame-styles';
import { ChartHost } from '../charts/host';
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

const chartMargins = { top: 16, right: 20, bottom: 42, left: 54 } as const;

export function UsageChart({ chart, hidden, valueFormatter }: { chart: UsageChartModel; hidden: Set<string>; valueFormatter: (value: number) => string }) {
  const { t } = useTranslation();
  const areaBoundaryStyles = useAreaBoundaryStyles();
  const chartRootStyles = useChartFrame();
  const locale = useLocale();
  const entryByLegend = useMemo(() => new Map(chart.entries.map(entry => [entry.legend, entry])), [chart.entries]);
  const visibleData = useMemo(() => visibleSeriesData(chart.entries, chart.plot.data, hidden), [chart.entries, chart.plot.data, hidden]);
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const dateFormatter = useCallback((date: Date) => formatAxisDate(date, chart.range, locale), [chart.range, locale]);

  const renderCallout = useCallback((point: CalloutPoint | null) => (
    <UsageChartCallout chart={chart} labelByTime={labelByTime} point={point} valueFormatter={valueFormatter} />
  ), [chart, labelByTime, valueFormatter]);

  // The chart keeps its own hover state across a range or view switch, so it
  // can ask for a callout carrying legends from the dataset it just replaced.
  // Such a row is dropped rather than substituted -- a table describing the
  // data must not name a series the data does not have.
  const lineCallout = useCallback((data?: CustomizedCalloutData) => renderCallout(data ? {
    x: data.x,
    rows: data.values.flatMap(value => {
      const entry = entryByLegend.get(value.legend);
      return entry ? [{ id: entry.id, label: entry.label, color: value.color, value: Number(value.y) }] : [];
    }),
  } : null), [entryByLegend, renderCallout]);

  const hasData = visibleData.lineChartData?.some(series => series.data.length > 0) ?? false;

  return (
    <ChartHost className={areaBoundaryStyles.root} emptyText={t('dashboard.usage.empty')} hasData={hasData}>
      {({ element, size }) => {
        const tickCount = Math.max(2, Math.min(chart.buckets.length <= 24 ? 6 : 7, Math.floor(Math.max(0, size.width - chartMargins.left - chartMargins.right) / 120)));
        const tickValues = chartTickValues(chart.buckets, tickCount).map(bucket => bucket.date);

        return chart.plot.form === 'area' ? (
          <StackedAreaChart
            customDateTimeFormatter={dateFormatter}
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
            customDateTimeFormatter={dateFormatter}
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
      }}
    </ChartHost>
  );
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
