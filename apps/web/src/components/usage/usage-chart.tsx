import { AreaChart, LineChart, type CustomizedCalloutData } from '@fluentui/react-charts';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CalloutPoint, UsageChartModel } from './types';
import { UsageChartCallout } from './usage-callout';
import { fluentComponents } from '../../fluent';
import { useLocale } from '../../lib/use-locale';
import { useUnclippedChartFrame } from '../charts/chart-frame-styles';
import { chartTickValues, formatAxisDate } from '../charts/dashboard-time';
import { useElementSize } from '../charts/use-element-size';
import { EmptyStateLine } from '../ui/empty-state';

const { makeStyles } = fluentComponents;

// WinUI ships no chart, so none of this transcribes a XAML dictionary; these
// are our own reading rules for a plot, and they are ours to state. Every
// value below is an alpha or a geometry, and the series hues come from a
// single palette that both colour schemes share, so one declaration serves
// light and dark alike.
//
// Series paint is also what forced colors leaves alone: the UA style sheet
// gives `svg` `forced-color-adjust: preserve-parent-color`, and Fluent opts
// only the axis text and gridlines back in with `forcedColorAdjust: 'auto'`.
// Distinct hues are how a multi-series plot is read, so nothing here opts the
// series back in either.
// https://drafts.csswg.org/css-color-adjust-1/#forced-color-adjust-prop
const useAreaBoundaryStyles = makeStyles({
  root: {
    // The boundary is what separates one stacked band from the next, so it is
    // held at full strength in every state. Fluent instead fades a stacked
    // area's own boundary to 0.3 at rest and restores it to 1 only while the
    // callout is open, which redraws every outline in the plot on hover.
    '& path[id*="-line-"]': { opacity: '1', strokeWidth: '2px' },
    // Fluent fills a band at 0.7, where two adjacent palette hues meet as
    // near-solid blocks and the boundary between them stops reading. At 0.42
    // each band stays a tint of the surface it sits on -- in either scheme --
    // and the boundary line is the strongest mark in the plot.
    '& path[id*="-graph-"]': { fillOpacity: '0.42' },
    // Both forms mark their buckets the same way. Fluent's area form draws no
    // point until one is hovered, which leaves the bucket count invisible at
    // rest, so every point is drawn at the radius and stroke the line form's
    // markers take. The area form's hover and keyboard focus keep Fluent's
    // fill inversion to colorNeutralBackground1, a token this dashboard's
    // WinUI layer re-points per scheme; the line form has no inversion of its
    // own and is marked by the highlight disc Fluent moves under the pointer,
    // which keeps its own size and is excluded here.
    '& circle:not([id*="staticHighlightCircle"])': { r: '2px', strokeWidth: '1.5px' },
  },
});

const chartMargins = { top: 16, right: 20, bottom: 42, left: 54 } as const;

export function UsageChart({ chart, valueFormatter, visibleLegends }: { chart: UsageChartModel; valueFormatter: (value: number) => string; visibleLegends: string[] }) {
  const { t } = useTranslation();
  const areaBoundaryStyles = useAreaBoundaryStyles();
  const chartRootStyles = useUnclippedChartFrame();
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

  // A callout can outlive the data it described: the chart keeps its own hover
  // state across a range or view switch and asks for a callout carrying legends
  // from the dataset that has just been replaced. Such a row no longer exists,
  // so it is dropped rather than substituted -- a table describing the data
  // must not name a series the data does not have -- and a callout left with no
  // rows renders nothing.
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
  // meant to be capped by. The lines are moved to the end of the series group,
  // which is the paint order the boundary rule above assumes.
  useLayoutEffect(() => {
    if (!host || chart.plot.form !== 'area') return;
    const frame = window.requestAnimationFrame(() => {
      const lines = [...host.querySelectorAll<SVGPathElement>('path[id*="-line-"]')];
      for (const line of lines.toReversed()) {
        const parent = line.parentNode;
        if (!parent) throw new Error('Area chart line is detached from its series');
        parent.append(line);
      }
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
