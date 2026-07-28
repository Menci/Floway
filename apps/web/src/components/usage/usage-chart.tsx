import { AreaChart, LineChart, type CustomizedCalloutData } from '@fluentui/react-charts';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { chartTickValues, formatAxisDate } from './chart-model';
import type { UsageChartModel } from './types';
import { UsageChartCallout } from './usage-callout';
import { fluentComponents } from '../../fluent';
import { localeForLanguage } from '../../i18n';
const { makeStyles } = fluentComponents;
const useChartStateStyles = makeStyles({ root: { alignItems: 'center', color: 'var(--colorNeutralForeground3)', display: 'grid', fontSize: '13px', height: '100%', justifyItems: 'center' } });
export function UsageChart({ chart, valueFormatter, visibleLegends }: { chart: UsageChartModel; valueFormatter: (value: number) => string; visibleLegends: string[] }) {
  const { i18n, t } = useTranslation();
  const chartStateStyles = useChartStateStyles();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(host);
  const locale = localeForLanguage(i18n.language);
  const labelByTime = useMemo(() => new Map(chart.buckets.map(bucket => [bucket.date.getTime(), bucket.label])), [chart.buckets]);
  const tickValues = useMemo(() => chartTickValues(chart.buckets).map(bucket => bucket.date), [chart.buckets]);
  const dateFormatter = useCallback((date: Date) => formatAxisDate(date, chart.range, locale), [chart.range, locale]);
  const callout = useCallback((data?: CustomizedCalloutData) => <UsageChartCallout chart={chart} data={data} labelByTime={labelByTime} locale={locale} valueFormatter={valueFormatter} />, [chart, labelByTime, locale, valueFormatter]);
  return (
    <div className="h-[320px] min-w-0 w-full" ref={setHost}>
      {size.width < 120 ? null : chart.data.lineChartData?.length ? (
        chart.stacked ? (
          <AreaChart
            data={chart.data}
            height={size.height}
            hideLegend
            legendProps={{
              selectedLegends: visibleLegends,
              canSelectMultipleLegends: true,
            }}
            margins={{ top: 16, right: 20, bottom: 42, left: 54 }}
            mode="tonexty"
            onRenderCalloutPerStack={callout}
            tickValues={tickValues}
            width={size.width}
            customDateTimeFormatter={dateFormatter}
            yAxisTickFormat={valueFormatter}
            yMinValue={0}
          />
        ) : (
          <LineChart
            data={chart.data}
            height={size.height}
            hideLegend
            legendProps={{
              selectedLegends: visibleLegends,
              canSelectMultipleLegends: true,
            }}
            margins={{ top: 16, right: 20, bottom: 42, left: 54 }}
            onRenderCalloutPerStack={callout}
            tickValues={tickValues}
            width={size.width}
            customDateTimeFormatter={dateFormatter}
            yAxisTickFormat={valueFormatter}
            yMaxValue={100}
            yMinValue={0}
          />
        )
      ) : (
        <div className={chartStateStyles.root}>{t('dashboard.usage.empty')}</div>
      )}
    </div>
  );
}

function useElementSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 320 });

  useLayoutEffect(() => {
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(260, Math.floor(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return size;
}
