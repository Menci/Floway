import type { ResetCycleQuota } from './reset-cycles';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatUsdNumber } from '../../lib/decimal-display';
import { formatNumber } from '../../lib/format-number';
import { numericDateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { dashboardInterval, isResetRange, type DashboardRange } from '../charts/dashboard-time';

const { Text, Tooltip } = fluentComponents;
export function CycleQuota({ range, loadedAt, quota }: { range: DashboardRange; loadedAt: number; quota: ResetCycleQuota | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (!isResetRange(range)) return null;
  const amount = quota === null ? null
    : quota.unit === 'usd' ? formatUsdNumber(quota.amount, locale)
      : quota.unit === 'credits' ? t('monitoring.controls.resetCycle.quota.credits', { count: quota.amount })
        : formatNumber(quota.amount, locale);
  const interval = dashboardInterval(range, loadedAt);
  return <div className="min-w-0 max-w-full justify-self-end text-right">
    {amount !== null && <Tooltip content={t('monitoring.controls.resetCycle.quota.reportedHint')} relationship="description">
      <Text className="text-fui-fg2 tabular-nums winui-focus-rect [overflow-wrap:anywhere]" role="note" size={200} tabIndex={0}>
        {t('monitoring.controls.resetCycle.quota.reported', { amount })}
      </Text>
    </Tooltip>}
    <Text as="p" className="text-fui-fg2" size={200}>
      {t('monitoring.controls.resetCycle.chartHours', {
        start: numericDateTime(new Date(interval.start)),
        end: numericDateTime(new Date(interval.end)),
      })}
    </Text>
  </div>;
}
