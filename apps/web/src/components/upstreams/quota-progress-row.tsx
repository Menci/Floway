import type { ReactNode } from 'react';

import { quotaBarColor } from './subscription-quota';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { clampPercent, percentText } from '../../lib/percent';

const { ProgressBar, Text } = fluentComponents;

export function QuotaProgressRow({ footer, label, percent, right }: {
  footer?: ReactNode;
  label: ReactNode;
  percent: number;
  right?: ReactNode;
}) {
  const { t } = useTranslation();
  const clamped = clampPercent(percent);

  return <div className="grid gap-1">
    <div className="flex items-baseline justify-between gap-3">
      <Text size={200}>{label}</Text>
      <div className="flex items-baseline gap-2">
        <Text size={200} className="text-fui-fg2">
          {clamped === null ? percentText(clamped) : t('dashboard.upstreamEditor.quotaRemainingPercent', { percent: 100 - clamped })}
        </Text>
        {right}
      </div>
    </div>
    {/* This is a remaining-quota bar, like a health bar, not usage progress, so its fill is 100 - used percent. */}
    <ProgressBar color={quotaBarColor(clamped)} max={100} thickness="large" value={clamped === null ? undefined : 100 - clamped} />
    {footer}
  </div>;
}
