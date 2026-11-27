import type { ResetCycleHistory } from './reset-cycles';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatUsd, formatUsdNumber } from '../../lib/decimal-display';
import { formatNumber } from '../../lib/format-number';
import { numericDateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { dashboardInterval, isResetRange, type DashboardRange } from '../charts/dashboard-time';

const { Text, Tooltip } = fluentComponents;
const unavailableReasons = {
  observations: 'monitoring.controls.resetCycle.quota.noObservations',
  prices: 'monitoring.controls.resetCycle.quota.noPrices',
  scope: 'monitoring.controls.resetCycle.quota.differentScope',
} as const;

export function CycleQuota({ range, loadedAt, quota }: { range: DashboardRange; loadedAt: number; quota?: ResetCycleHistory['quota'] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (!isResetRange(range)) return null;

  let text: string;
  let hint: string;
  if (quota?.kind === 'estimated') {
    text = t('monitoring.controls.resetCycle.quota.estimated', { amount: formatUsd(quota.usd) });
    hint = t('monitoring.controls.resetCycle.quota.estimateHint');
  } else if (quota?.kind === 'reported') {
    const amount = quota.unit === 'usd' ? formatUsdNumber(quota.amount, locale)
      : quota.unit === 'credits' ? t('monitoring.controls.resetCycle.quota.credits', { count: quota.amount })
        : formatNumber(quota.amount, locale);
    text = t('monitoring.controls.resetCycle.quota.reported', { amount });
    hint = t('monitoring.controls.resetCycle.quota.reportedHint');
  } else {
    text = t('monitoring.controls.resetCycle.quota.unavailable');
    hint = t(unavailableReasons[quota?.reason ?? 'observations']);
  }

  const interval = dashboardInterval(range, loadedAt);
  return <div className="min-w-0 max-w-full justify-self-end text-right">
    <Tooltip content={hint} relationship="description">
      <Text className="text-fui-fg2 tabular-nums winui-focus-rect [overflow-wrap:anywhere]" role="note" size={200} tabIndex={0}>{text}</Text>
    </Tooltip>
    <Text as="p" className="text-fui-fg2" size={200}>
      {t('monitoring.controls.resetCycle.chartHours', {
        start: numericDateTime(new Date(interval.start)),
        end: numericDateTime(new Date(interval.end)),
      })}
    </Text>
  </div>;
}
