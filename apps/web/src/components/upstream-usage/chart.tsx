import { LineChart, type CustomizedCalloutData } from '@fluentui/react-charts';
import { curveStepAfter } from 'd3-shape';
import { useMemo, useState } from 'react';

import { gaugePoints, type UpstreamUsageChart } from './plot';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
import { ChartCalloutTable } from '../charts/callout-table';
import { formatAxisDate } from '../charts/dashboard-time';
import { useChartFrame } from '../charts/frame-styles';
import { ChartHost } from '../charts/host';
import { chartMargins } from '../charts/layout';
import { colorForHue } from '../charts/palette';
import { ChartSection } from '../charts/section';

export function UpstreamUsageChartSection({ chart, start, end }: { chart: UpstreamUsageChart; start: number; end: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = useChartFrame();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const unitLabel = t(`dashboard.upstreamUsage.units.${chart.unit}`);
  const margins = { ...chartMargins, left: chart.unit === 'usd' ? 100 : chartMargins.left };
  const format = (value: number) => chart.unit === 'percent' ? `${value.toLocaleString(locale, { maximumFractionDigits: 2 })}%`
    : chart.unit === 'usd' ? value.toLocaleString(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 })
      : value.toLocaleString(locale, { maximumFractionDigits: 2 });
  const data = useMemo(() => ({
    chartTitle: chart.title,
    lineChartData: chart.entries.filter(entry => !hidden.has(entry.id)).map(entry => ({
      legend: entry.legend,
      color: colorForHue(entry.hue),
      lineOptions: { strokeWidth: 2, curve: curveStepAfter },
      data: gaugePoints(chart.values.get(entry.id)!, start, end),
    })),
  }), [chart, end, hidden, start]);
  const renderCallout = (point?: CustomizedCalloutData) => point === undefined ? null : <ChartCalloutTable
    columns={[{ key: 'value', label: unitLabel }]}
    rows={point.values.map(value => ({ key: value.legend, label: value.legend, color: value.color, values: [format(Number(value.y))] }))}
    title={formatAxisDate(point.x as Date)}
  />;
  return <ChartSection controlsLabel={chart.title} emptyText={t('dashboard.upstreamUsage.empty')} entries={chart.entries} hidden={hidden} onHiddenChange={setHidden} title={t('dashboard.upstreamUsage.chartTitle', { name: chart.title, unit: unitLabel })}>
    <ChartHost className="" emptyText={t('dashboard.upstreamUsage.empty')} hasData={data.lineChartData.length > 0}>
      {({ size }) => {
        const tickCount = Math.max(2, Math.min(7, Math.floor(Math.max(0, size.width - margins.left - margins.right) / 120)));
        return <LineChart
          customDateTimeFormatter={formatAxisDate}
          data={data}
          enablePerfOptimization
          height={size.height}
          hideLegend
          margins={margins}
          onRenderCalloutPerStack={renderCallout}
          styles={styles}
          tickValues={Array.from({ length: tickCount }, (_, index) => new Date(start + (end - start) * index / (tickCount - 1)))}
          width={size.width}
          yAxisTickFormat={format}
          yMaxValue={chart.unit === 'percent' ? 100 : undefined}
          yMinValue={0}
        />;
      }}
    </ChartHost>
  </ChartSection>;
}
