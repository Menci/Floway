import type { ComponentProps } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, Tooltip } = fluentComponents;

export function TooltipIconButton({ className, disabled, icon, label, onClick, size = 'small' }: {
  className?: string;
  disabled?: boolean;
  icon: React.ReactElement;
  label: string;
  onClick: () => void;
  size?: ComponentProps<typeof Button>['size'];
}) {
  return <Tooltip content={label} relationship="label">
    <Button
      appearance="subtle"
      aria-label={label}
      className={className}
      disabled={disabled}
      icon={icon}
      onClick={onClick}
      size={size}
    />
  </Tooltip>;
}
