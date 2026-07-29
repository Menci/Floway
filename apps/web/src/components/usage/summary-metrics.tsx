import { useTranslation } from 'react-i18next';

import { formatSummaryMetric, metricConfig, summaryMetrics } from './chart-model';
import type { TokenSummary, UsageMetric } from './types';
import { fluentComponents } from '../../fluent';
const { Text, ToggleButton, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  selectedText: { color: 'inherit' },
});

function SummaryMetricButton({
  active,
  label,
  onClick,
  value,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  value: string;
}) {
  const s = useStyles();
  return (
    <ToggleButton
      appearance="subtle"
      checked={active}
      className="!h-auto !justify-start !min-h-[62px] !p-2 !text-left min-w-0"
      onClick={onClick}
    >
      <span className="grid gap-1 min-w-0">
        <Text size={200} weight="semibold" className={mergeClasses('leading-[1.2]', active ? s.selectedText : 'text-fui-fg2')}>{label}</Text>
        <Text size={500} weight="semibold" className={mergeClasses('overflow-wrap-anywhere', active && s.selectedText)}>{value}</Text>
      </span>
    </ToggleButton>
  );
}
export function SummaryMetrics({ locale, metric, onMetricChange, summary }: { locale: string; metric: UsageMetric; onMetricChange: (metric: UsageMetric) => void; summary: TokenSummary }) {
  const { t } = useTranslation();
  return <div className="grid gap-2.5 grid-cols-5 max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
    {summaryMetrics.map(group => <div className="grid gap-2 min-w-0" key={group.join('-')}>
      {group.map(item => <SummaryMetricButton active={metric === item} key={item} label={t(metricConfig[item].labelKey)} onClick={() => onMetricChange(item)} value={formatSummaryMetric(summary, item, locale)} />)}
    </div>)}
  </div>;
}
