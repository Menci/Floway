import type { MouseEvent, ReactElement } from 'react';

import { useDangerActionClasses } from './danger';
import { fluentComponents } from '../../fluent';

const { Button, Tooltip, mergeClasses } = fluentComponents;

export function TooltipIconButton({ className, danger = false, disabled = false, icon, label, onClick }: {
  className?: string;
  danger?: boolean;
  disabled?: boolean;
  icon: ReactElement;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const dangerClasses = useDangerActionClasses();
  return <Tooltip content={label} relationship="label">
    <Button
      appearance="subtle"
      aria-label={label}
      className={mergeClasses(danger && dangerClasses.button, className)}
      disabled={disabled}
      icon={icon}
      onClick={onClick}
      size="small"
    />
  </Tooltip>;
}
