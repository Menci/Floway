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

export function TooltipIconButton({ className, danger = false, disabled, icon, label, onClick }: {
  className?: string;
  danger?: boolean;
  disabled?: boolean;
  icon: React.ReactElement;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const s = useStyles();
  const dangerClasses = useDangerActionClasses();
  return <Tooltip content={label} relationship="label">
    <Button
      appearance="subtle"
      aria-label={label}
      className={mergeClasses(s.action, danger && dangerClasses.button, className)}
      disabled={disabled}
      icon={icon}
      onClick={onClick}
      size="small"
    />
  </Tooltip>;
}
