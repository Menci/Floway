import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { clampPercent, percentText } from '../../lib/percent';
import { quotaBarColor } from './subscription-quota';

const { ProgressBar, Text } = fluentComponents;

export function QuotaProgressRow({ footer, label, percent, right }: {
  footer?: ReactNode;
  label: ReactNode;
  percent: number;
  right?: ReactNode;
}) {
  const clamped = clampPercent(percent);

  return <div className="grid gap-1">
    <div className="flex items-baseline justify-between gap-3">
      <Text size={200}>{label}</Text>
      <div className="flex items-baseline gap-2">
        <Text size={200} className="text-fui-fg2">{percentText(clamped)}</Text>
        {right}
      </div>
    </div>
    <ProgressBar color={quotaBarColor(clamped)} max={100} thickness="large" value={clamped ?? undefined} />
    {footer}
  </div>;
}
