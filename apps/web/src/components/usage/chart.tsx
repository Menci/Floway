import { AreaChart, LineChart, type CustomizedCalloutData } from '@fluentui/react-charts';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { UsageChartCallout } from './callout';
import type { CalloutPoint, UsageChartModel } from './types';
import { fluentComponents } from '../../fluent';
import { useLocale } from '../../lib/use-locale';
import { chartTickValues, formatAxisDate } from '../charts/dashboard-time';
import { useChartFrame } from '../charts/frame-styles';
import { useElementSize } from '../charts/use-element-size';
import { EmptyStateLine } from '../ui/empty-state';

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

export function UsageChart({ chart, valueFormatter, visibleLegends }: { chart: UsageChartModel; valueFormatter: (value: number) => string; visibleLegends: string[] }) {
  const { t } = useTranslation();
  const areaBoundaryStyles = useAreaBoundaryStyles();
  const chartRootStyles = useChartFrame();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(host);
  const locale = useLocale();
  const entryByLegend = useMemo(() => new Map(chart.entries.map(entry => [entry.legend, entry])), [chart.entries]);
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const tickCount = Math.max(2, Math.min(chart.buckets.length <= 24 ? 6 : 7, Math.floor(Math.max(0, size.width - chartMargins.left - chartMargins.right) / 120)));
  const tickValues = useMemo(() => chartTickValues(chart.buckets, tickCount).map(bucket => bucket.date), [chart.buckets, tickCount]);
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

  const hasData = chart.plot.data.lineChartData?.some(series => series.data.length > 0) ?? false;

  // Fluent emits each stacked band right after its own boundary line, and the
  // band's top edge is that line, so every band paints over the stroke it was
  // meant to be capped by. Moving the lines to the end of the series group is
  // the paint order the boundary rule above assumes.
  useLayoutEffect(() => {
    if (!host || chart.plot.form !== 'area') return;
    const frame = window.requestAnimationFrame(() => {
      const lines = [...host.querySelectorAll<SVGPathElement>('path[id*="-line-"]')];
      // Each run starts from the order the previous one left, so appending them
      // as found reverses them and the next run reverses them back, flipping
      // which colour wins wherever two boundaries coincide. Sorting by the
      // series index the id carries is the fixed point: the lowest series ends
      // up last and stays on top however this pass finds them.
      for (const line of lines.sort((a, b) => Number.parseInt(b.id, 10) - Number.parseInt(a.id, 10))) line.parentNode?.append(line);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chart.plot.data, chart.plot.form, host, size.height, size.width]);

  if (size.width < 120) return <div className="h-[320px] min-w-0 w-full" ref={setHost} />;

  return (
    <div className={`${areaBoundaryStyles.root} h-[320px] min-w-0 w-full`} ref={setHost}>
      {!hasData ? <div className="grid h-full place-items-center"><EmptyStateLine>{t('dashboard.usage.empty')}</EmptyStateLine></div>
        : chart.plot.form === 'area' ? (
          <AreaChart
            customDateTimeFormatter={dateFormatter}
            data={chart.plot.data}
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
            data={chart.plot.data}
            enablePerfOptimization
            height={size.height}
            hideLegend
            legendProps={{ selectedLegends: visibleLegends, canSelectMultipleLegends: true }}
            margins={chartMargins}
            onRenderCalloutPerStack={lineCallout}
            styles={chartRootStyles}
            tickValues={tickValues}
            width={size.width}
            yAxisTickFormat={valueFormatter}
            yMaxValue={100}
            yMinValue={0}
          />
        )}
    </div>
  );
}
