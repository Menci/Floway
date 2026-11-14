import type { ReactNode } from 'react';

import { quotaBarColor } from './subscription-quota';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { clampPercent, percentText } from '../../lib/percent';
import type { QuotaDisplay } from '@floway-dev/protocols/browser';

const { ProgressBar, Text } = fluentComponents;

export function QuotaProgressRow({ footer, label, percent, quotaDisplay, right }: {
  footer?: ReactNode;
  label: ReactNode;
  /** Used percent as the upstream reports it. */
  percent: number;
  quotaDisplay: QuotaDisplay;
  right?: ReactNode;
}) {
  const { t } = useTranslation();
  const used = clampPercent(percent);
  const shown = used === null ? null : quotaDisplay === 'used' ? used : 100 - used;

  return <div className="grid gap-1">
    <div className="flex items-baseline justify-between gap-3">
      <Text size={200}>{label}</Text>
      <div className="flex items-baseline gap-2">
        <Text size={200} className="text-fui-fg2 tabular-nums">
          {shown === null ? percentText(shown) : t(quotaDisplay === 'used' ? 'dashboard.upstreamEditor.quotaUsedPercent' : 'dashboard.upstreamEditor.quotaRemainingPercent', { percent: shown })}
        </Text>
        {right}
      </div>
    </div>
    <ProgressBar color={quotaBarColor(used)} max={100} thickness="large" value={shown ?? undefined} />
    {footer}
  </div>;
}
