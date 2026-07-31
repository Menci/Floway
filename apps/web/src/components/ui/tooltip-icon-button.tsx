import type { MouseEvent, ReactElement } from 'react';

import { useDangerActionClasses } from './danger-action';
import { fluentComponents } from '../../fluent';

const { Button, Tooltip, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  action: {
    transitionDuration: '0s',
    ':enabled:active': {
      backgroundColor: 'var(--colorSubtleBackgroundPressed) !important',
    },
  },
});

export function TooltipIconButton({ className, danger = false, disabled = false, icon, label, onClick }: {
  className?: string;
  danger?: boolean;
  disabled?: boolean;
  icon: ReactElement;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const styles = useStyles();
  const dangerClasses = useDangerActionClasses();
  return <Tooltip content={label} relationship="label">
    <Button
      appearance="subtle"
      aria-label={label}
      className={mergeClasses(styles.action, danger && dangerClasses.button, className)}
      disabled={disabled}
      icon={icon}
      onClick={onClick}
      size="small"
    />
  </Tooltip>;
}
