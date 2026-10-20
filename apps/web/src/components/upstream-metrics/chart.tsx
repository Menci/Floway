import { useCallback, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';

import { upstreamMetricsPlotRows, type UpstreamMetricsChart } from './plot';
import { useTranslation } from '../../i18n/translation';
import { formatUsdNumber } from '../../lib/decimal-display';
import { numericDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { AssumedChartHover } from '../charts/assumed-hover';
import { ChartCalloutPopover } from '../charts/callout-popover';
import { ChartCalloutTable } from '../charts/callout-table';
import { formatAxisDate } from '../charts/dashboard-time';
import { chartTickStyle, useChartFrame } from '../charts/frame-styles';
import { ChartHost } from '../charts/host';
import { chartMargins, chartPlotWidth, chartTickCount } from '../charts/layout';
import { chartHoverPointer, chartPointerOffset, LinkedChartAssumedHover, nearestChartPoint, useLinkedChartHover, type ChartHoverPointerStore } from '../charts/linked-hover';
import { colorForHue } from '../charts/palette';
import { seriesRunBoundaryPoints } from '../charts/point-markers';
import { ChartSection } from '../charts/section';
import { withUniqueSeriesLegends } from '../charts/series-legends';
import type { UpstreamMetricUnit } from '@floway-dev/provider/browser';

const unitAxisTieBreakers: Record<UpstreamMetricUnit, number> = {
  percent: 5,
  usd: 4,
  count: 3,
  credits: 2,
  none: 1,
};
const metricAxis = (values: readonly number[], unit: UpstreamMetricUnit) => {
  const minimum = values.reduce((bound, value) => Math.min(bound, value), 0);
  const maximum = values.reduce((bound, value) => Math.max(bound, value), unit === 'percent' ? 100 : 0);
  const upper = minimum === maximum ? maximum + 1 : maximum;
  const interval = upper / 4 - minimum / 4;
  const step = Math.max(Number.MIN_VALUE, interval >= 1 ? Math.ceil(interval) : interval);
  const ticks = [minimum < 0 ? 0 : minimum];
  if (minimum < 0) {
    while (ticks.at(-1)! > minimum) ticks.push(Math.max(minimum, ticks.at(-1)! - step));
    ticks.reverse();
  }
  while (ticks.at(-1)! < upper) ticks.push(Math.min(upper, ticks.at(-1)! + step));
  return { ticks, domain: [ticks[0]!, ticks.at(-1)!] as [number, number] };
};

function MetricsCallout({ active, coordinate, label, payload, element, formatters, pointerStore }: TooltipContentProps & { element: HTMLElement; formatters: Record<UpstreamMetricUnit, (value: number) => string>; pointerStore: ChartHoverPointerStore }) {
  const { t } = useTranslation();
  if (!active || coordinate === undefined) return null;
  const target = {
    getBoundingClientRect: () => {
      const rect = element.getBoundingClientRect();
      const pointer = pointerStore.getSnapshot();
      const offset = pointer === null ? null : chartPointerOffset(pointer, rect);
      return new DOMRect(rect.left + (offset?.x ?? coordinate.x), rect.top + (offset?.y ?? coordinate.y), 0, 0);
    },
  };
  return <ChartCalloutPopover pointerStore={pointerStore} target={target}>
    <ChartCalloutTable
      columns={[{ key: 'value', label: t('dashboard.upstreamMetrics.value') }]}
      rows={payload.map(value => ({ key: value.graphicalItemId, label: value.name, color: value.color!, values: [formatters[value.unit as UpstreamMetricUnit](value.value as number)] }))}
      title={formatAxisDate(new Date(Number(label)))}
    />
  </ChartCalloutPopover>;
}

export function UpstreamMetricsChartSection({ chart, start, end }: { chart: UpstreamMetricsChart; start: number; end: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const frameStyles = useChartFrame();
  const [visibilityOverrides, setVisibilityOverrides] = useState<Map<string, boolean>>(() => new Map());
  const hidden = useMemo(() => new Set(chart.entries
    .filter(entry => visibilityOverrides.get(entry.id) ?? chart.hiddenByDefault.has(entry.id))
    .map(entry => entry.id)), [chart.entries, chart.hiddenByDefault, visibilityOverrides]);
  const onHiddenChange = useCallback((targetHidden: Set<string>) => setVisibilityOverrides(current => {
    let next = current;
    for (const { id } of chart.entries) {
      const currentHidden = current.get(id) ?? chart.hiddenByDefault.has(id);
      const target = targetHidden.has(id);
      if (currentHidden === target) continue;
      if (next === current) next = new Map(current);
      next.set(id, target);
    }
    return next;
  }), [chart.entries, chart.hiddenByDefault]);
  const units = useMemo(() => {
    const priorities = new Map<UpstreamMetricUnit, number>();
    for (const entry of chart.entries) {
      if (hidden.has(entry.id)) continue;
      priorities.set(entry.unit, Math.max(priorities.get(entry.unit) ?? Number.NEGATIVE_INFINITY, entry.axisPriority));
    }
    return (Object.keys(unitAxisTieBreakers) as UpstreamMetricUnit[])
      .filter(unit => chart.entries.some(entry => entry.unit === unit))
      .sort((left, right) => (priorities.get(right) ?? Number.NEGATIVE_INFINITY) - (priorities.get(left) ?? Number.NEGATIVE_INFINITY) || unitAxisTieBreakers[right] - unitAxisTieBreakers[left]);
  }, [chart.entries, hidden]);
  const data = useMemo(() => upstreamMetricsPlotRows(chart, start, end), [chart, end, start]);
  const linkedHover = useLinkedChartHover();
  const [realHover, setRealHover] = useState(false);
  const axes = useMemo(() => new Map(units.map(unit => [unit, metricAxis(chart.entries.filter(entry => entry.unit === unit).flatMap(entry => data.flatMap(row => entry.id in row.values ? [row.values[entry.id]!] : [])), unit)])), [chart.entries, data, units]);
  const series = withUniqueSeriesLegends(chart.entries);
  // Areas paint under lines, so they render first and a native tooltip lists
  // them in that order. A tooltip this chart draws for another chart's hover
  // builds its rows itself, so it follows the same order rather than the model's.
  const drawOrder = series.toSorted((left, right) => Number(left.form === 'line') - Number(right.form === 'line'));
  if (chart.entries.length === 0) return null;
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const formatters: Record<UpstreamMetricUnit, (value: number) => string> = {
    percent: value => `${numberFormat.format(value)}%`,
    usd: value => formatUsdNumber(value, locale, { maximumFractionDigits: 5 }),
    credits: numberFormat.format,
    count: numberFormat.format,
    none: numberFormat.format,
  };
  return <ChartSection controlsLabel={chart.title} emptyText={t('dashboard.upstreamMetrics.empty')} entries={series} hidden={hidden} onHiddenChange={onHiddenChange} title={chart.title}>
    <ChartHost className={frameStyles.root} emptyText={t('dashboard.upstreamMetrics.empty')} hasData={chart.entries.some(entry => !hidden.has(entry.id) && data.some(row => entry.id in row.values))}
      onMouseEnter={() => setRealHover(true)} onMouseLeave={() => { setRealHover(false); linkedHover.report(null); }}>
      {({ element, size }) => {
        const plotWidth = chartPlotWidth(size.width);
        const tickCount = chartTickCount(plotWidth);
        const renderedChart = <ComposedChart
          accessibilityLayer
          aria-label={chart.title}
          data={data}
          height={size.height}
          margin={{ top: chartMargins.top, right: chartMargins.right, bottom: 0, left: 0 }}
          onMouseMove={(state, event) => {
            setRealHover(true);
            linkedHover.report(state.isTooltipActive ? chartHoverPointer(element, event.clientX, event.clientY) : null);
          }}
          width={size.width}
        >
          <CartesianGrid stroke="var(--colorNeutralForeground1)" strokeOpacity={0.2} strokeWidth={1} vertical={false} yAxisId={units[0]!} />
          <XAxis
            axisLine={false}
            dataKey="timestamp"
            domain={[start, end]}
            height={chartMargins.bottom}
            interval="preserveStartEnd"
            scale="time"
            tick={chartTickStyle}
            tickFormatter={value => plotWidth < 240 ? numericDate(new Date(value)) : formatAxisDate(new Date(value))}
            tickLine={false}
            ticks={Array.from({ length: tickCount }, (_, index) => start + (end - start) * index / (tickCount - 1))}
            type="number"
          />
          {units.map((unit, index) => <YAxis
            axisLine={false}
            domain={axes.get(unit)!.domain}
            includeHidden
            hide={index >= 1}
            key={unit}
            orientation="left"
            tick={chartTickStyle}
            tickFormatter={formatters[unit]}
            tickLine={false}
            ticks={axes.get(unit)!.ticks}
            width={index === 0 ? chartMargins.left : 0}
            yAxisId={unit}
          />)}

          <Tooltip
            content={props => <MetricsCallout {...props} element={element} formatters={formatters} pointerStore={linkedHover.pointerStore} />}
            cursor={{ stroke: 'var(--colorNeutralStroke1)', strokeDasharray: '5,5' }}
            filterNull
            isAnimationActive={false}
            itemSorter="dataKey"
            portal={element}
            wrapperStyle={{ position: 'static', transform: 'none' }}
          />
          {drawOrder.map(entry => {
            const Series = entry.form === 'area' ? Area : Line;
            const color = colorForHue(entry.hue);
            const values = data.map(row => row.values[entry.id]);
            const markers = seriesRunBoundaryPoints(values);
            return <Series
              activeDot={{ r: 4 }}
              connectNulls
              dataKey={(row: (typeof data)[number]) => row.values[entry.id]}
              dot={({ cx, cy, index }) => values[index] === undefined
                ? <g />
                : <circle cx={cx} cy={cy} fill={color} r={markers[index] ? 2 : 0} stroke={color} strokeWidth={1.5} />}
              hide={hidden.has(entry.id)}
              isAnimationActive={false}
              key={entry.id}
              name={entry.legend}
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.16}
              type="monotoneX"
              unit={entry.unit}
              yAxisId={entry.unit}
            />;
          })}
        </ComposedChart>;
        const assumedCallout = (row: (typeof data)[number]) => {
          if (realHover) return null;
          const rows = drawOrder.flatMap(entry => {
            const value = row.values[entry.id];
            return value === undefined || hidden.has(entry.id) ? [] : [{ key: entry.id, label: entry.legend, color: colorForHue(entry.hue), values: [formatters[entry.unit](value)] }];
          });
          if (rows.length === 0) return null;
          const x = chartMargins.left + (row.timestamp - start) / (end - start) * plotWidth;
          return <AssumedChartHover bottom={chartMargins.bottom} element={element} pointerStore={linkedHover.pointerStore} top={chartMargins.top} x={x}>
            <ChartCalloutTable columns={[{ key: 'value', label: t('dashboard.upstreamMetrics.value') }]} rows={rows} title={formatAxisDate(new Date(row.timestamp))} />
          </AssumedChartHover>;
        };
        return <>
          {renderedChart}
          <LinkedChartAssumedHover hover={linkedHover.assumedHover} resolve={pointer => {
            const time = start + pointer.xRatio * (end - start);
            return nearestChartPoint(data, time, row => row.timestamp);
          }}>{assumedCallout}</LinkedChartAssumedHover>
        </>;
      }}
    </ChartHost>
  </ChartSection>;
}
