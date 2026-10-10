import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';

import { upstreamUsagePlotRows, type UpstreamUsageChart } from './plot';
import { useTranslation } from '../../i18n/translation';
import { numericDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { ChartCalloutTable } from '../charts/callout-table';
import { formatAxisDate } from '../charts/dashboard-time';
import { chartCalloutStyle, chartTickStyle } from '../charts/frame-styles';
import { ChartHost } from '../charts/host';
import { chartMargins } from '../charts/layout';
import { colorForHue } from '../charts/palette';
import { ChartSection } from '../charts/section';
import { withUniqueSeriesLegends } from '../charts/series-legends';
import type { UsageMetricUnit } from '@floway-dev/provider/browser';

const unitAxes: Record<UsageMetricUnit, { priority: number; width: number }> = {
  percent: { priority: 3, width: chartMargins.left },
  usd: { priority: 2, width: 80 },
  credits: { priority: 1, width: chartMargins.left },
};
const calloutStyle = {
  ...chartCalloutStyle,
  border: '1px solid var(--winui-surface-stroke-flyout)',
  borderRadius: 'var(--borderRadiusMedium)',
  boxShadow: 'var(--shadow16)',
};

export function UpstreamUsageChartSection({ chart, start, end }: { chart: UpstreamUsageChart; start: number; end: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const units = (Object.keys(unitAxes) as UsageMetricUnit[])
    .filter(unit => chart.entries.some(entry => entry.unit === unit))
    .sort((left, right) => unitAxes[right].priority - unitAxes[left].priority);
  const data = useMemo(() => upstreamUsagePlotRows(chart, start, end), [chart, end, start]);
  const series = withUniqueSeriesLegends(chart.entries.map(entry => ({ ...entry, label: units.length > 1 ? t('dashboard.upstreamUsage.metricOption', { name: entry.label, unit: t(`dashboard.upstreamUsage.units.${entry.unit}`) }) : entry.label })));
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const formatters: Record<UsageMetricUnit, (value: number) => string> = {
    percent: value => `${numberFormat.format(value)}%`,
    usd: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 }).format,
    credits: numberFormat.format,
  };
  const renderCallout = ({ active, label, payload }: TooltipContentProps) => !active ? null : <div aria-live="polite" role="status" style={calloutStyle}>
    <ChartCalloutTable
      columns={[{ key: 'value', label: t('dashboard.upstreamUsage.value') }]}
      rows={payload.map(value => ({ key: value.graphicalItemId, label: value.name, color: value.color!, values: [formatters[value.unit as UsageMetricUnit](value.value as number)] }))}
      title={formatAxisDate(new Date(Number(label)))}
    />
  </div>;
  return <ChartSection controlsLabel={chart.title} emptyText={t('dashboard.upstreamUsage.empty')} entries={series} hidden={hidden} onHiddenChange={setHidden} title={chart.title}>
    <ChartHost className="" emptyText={t('dashboard.upstreamUsage.empty')} hasData={chart.entries.some(entry => !hidden.has(entry.id))}>
      {({ size }) => {
        const plotWidth = size.width - units.slice(0, 2).reduce((width, unit) => width + unitAxes[unit].width, 0);
        const tickCount = Math.max(2, Math.min(7, Math.floor(plotWidth / 120)));
        return <LineChart
          accessibilityLayer
          aria-label={chart.title}
          data={data}
          height={size.height}
          margin={{ top: chartMargins.top, right: 0, bottom: 0, left: 0 }}
          width={size.width}
        >
          <CartesianGrid stroke="var(--colorNeutralStroke2)" vertical={false} yAxisId={units[0]!} />
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
            domain={([minimum, maximum]: readonly [number, number]) => {
              const lower = Math.min(0, minimum);
              const upper = unit === 'percent' ? Math.max(100, maximum) : Math.max(0, maximum);
              return [lower, upper === lower ? upper + 1 : upper];
            }}
            includeHidden
            hide={index >= 2}
            key={unit}
            orientation={index === 0 ? 'left' : 'right'}
            tick={chartTickStyle}
            tickFormatter={formatters[unit]}
            tickLine={false}
            width={index < 2 ? unitAxes[unit].width : 0}
            yAxisId={unit}
          />)}
          <Tooltip content={renderCallout} cursor={{ stroke: 'var(--colorNeutralStroke1)' }} filterNull isAnimationActive={false} itemSorter="dataKey" />
          {series.map(entry => <Line
            activeDot={{ r: 4 }}
            dataKey={(row: (typeof data)[number]) => row.values[entry.id]}
            dot={false}
            hide={hidden.has(entry.id)}
            isAnimationActive={false}
            key={entry.id}
            name={entry.legend}
            stroke={colorForHue(entry.hue)}
            strokeWidth={2}
            type="stepAfter"
            unit={entry.unit}
            yAxisId={entry.unit}
          />)}
        </LineChart>;
      }}
    </ChartHost>
  </ChartSection>;
}
