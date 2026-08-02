import { useTranslation } from 'react-i18next';

import type { UsageChartModel } from './types';
import { UsageChart } from './usage-chart';
import { ChartSection } from '../charts/section';

export function UsageChartSection({
  chart,
  detailsLabel,
  hidden,
  onHiddenChange,
  title,
  valueFormatter,
}: {
  chart: UsageChartModel;
  detailsLabel: string;
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
  title: string;
  valueFormatter: (value: number) => string;
}) {
  const { t } = useTranslation();
  const visibleLegends = chart.entries
    .filter(entry => !hidden.has(entry.id))
    .map(entry => entry.legend);

  return (
    <ChartSection
      controlsLabel={detailsLabel}
      emptyText={t('dashboard.usage.empty')}
      entries={chart.entries}
      hidden={hidden}
      onHiddenChange={onHiddenChange}
      title={title}
    >
      <UsageChart chart={chart} valueFormatter={valueFormatter} visibleLegends={visibleLegends} />
    </ChartSection>
  );
}
