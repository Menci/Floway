import type { MouseEvent, ReactElement } from 'react';

import { useDangerActionClasses } from './danger';
import { fluentComponents } from '../../fluent';

const { Button, Tooltip, mergeClasses } = fluentComponents;

// `disabled` is for a control made unavailable by something outside itself: it
// emits the HTML attribute, so the control leaves the tab order and focus is
// lost. `disabledFocusable` emits aria-disabled alone, keeping focus and tab
// order while Fluent suppresses the click, and is what a control whose own
// command is in flight takes — the button the operator just pressed must not
// pull focus out from under them. XAML draws the same line with
// FrameworkElement.AllowFocusWhenDisabled.
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.frameworkelement.allowfocuswhendisabled
export function TooltipIconButton({ className, danger = false, disabled = false, disabledFocusable = false, icon, label, onClick }: {
  className?: string;
  danger?: boolean;
  disabled?: boolean;
  disabledFocusable?: boolean;
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
      disabledFocusable={disabledFocusable}
      icon={icon}
      onClick={onClick}
      size="small"
    />
  </Tooltip>;
}
