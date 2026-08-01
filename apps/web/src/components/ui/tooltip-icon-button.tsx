import type { MouseEvent, ReactElement } from 'react';

import { useDangerActionClasses } from './danger';
import { fluentComponents } from '../../fluent';

// A command that is an icon and a tooltip, in the rows and toolbars where a
// label would not fit. The subtle appearance carries WinUI's SubtleButtonStyle,
// whose fills, foregrounds, focus rings and press timing the WinUI layer
// already states for every button; danger adds the one thing that is this
// component's own, the warning colour a destructive command takes while it is
// being reached for.
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
