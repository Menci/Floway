import { UsageChart } from './chart';
import type { UsageChartModel } from './types';
import { useTranslation } from '../../i18n/translation';
import { ChartSection } from '../charts/section';

export function UsageChartSection({
  actions,
  chart,
  detailsLabel,
  hidden,
  onHiddenChange,
  title,
  valueFormatter,
}: {
  actions?: React.ReactNode;
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
      actions={actions}
      controlsLabel={detailsLabel}
      emptyText={t('monitoring.usage.empty')}
      entries={chart.entries}
      hidden={hidden}
      onHiddenChange={onHiddenChange}
      title={title}
      weights={chart.weights}
    >
      <UsageChart chart={chart} hidden={hidden} valueFormatter={valueFormatter} />
    </ChartSection>
  );
}
