import { UsageChart } from './chart';
import type { UsageChartModel } from './types';
import { useTranslation } from '../../i18n/translation';
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

  return (
    <ChartSection
      controlsLabel={detailsLabel}
      emptyText={t('dashboard.usage.empty')}
      entries={chart.entries}
      hidden={hidden}
      onHiddenChange={onHiddenChange}
      title={title}
    >
      <UsageChart chart={chart} hidden={hidden} valueFormatter={valueFormatter} />
    </ChartSection>
  );
}
