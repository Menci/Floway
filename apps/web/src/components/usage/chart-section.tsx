import type { ReactNode } from 'react';

import { UsageChart } from './chart';
import type { UsageChartModel } from './types';
import { useTranslation } from '../../i18n/translation';
import { ChartSection, type ChartSectionOther } from '../charts/section';

export function UsageChartSection({
  actions,
  chart,
  detailsLabel,
  hidden,
  onHiddenChange,
  other,
  title,
  valueFormatter,
}: {
  actions?: ReactNode;
  chart: UsageChartModel;
  detailsLabel: string;
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
  other?: ChartSectionOther | undefined;
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
      other={other}
      title={title}
      weights={chart.weights}
    >
      <UsageChart chart={chart} hidden={hidden} valueFormatter={valueFormatter} />
    </ChartSection>
  );
}
