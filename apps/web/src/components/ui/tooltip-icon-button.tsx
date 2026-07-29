import { fluentComponents } from '../../fluent';

const { Button, Tooltip, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  action: {
    transitionDuration: '0s',
    ':enabled:active': {
      backgroundColor: 'var(--colorSubtleBackgroundPressed) !important',
      borderColor: 'transparent !important',
    },
  },
  // A destructive action reads as destructive when the operator reaches for
  // it: resident red would shout from every row and break its rhythm.
  // The `:enabled` guard matters: without it the warning colour would also
  // paint a delete the operator is not allowed to press.
  danger: {
    '& .fui-Button__icon': { color: 'inherit !important' },
    ':enabled:hover': { color: 'var(--colorPaletteRedForeground1) !important' },
    ':enabled:active': { color: 'var(--colorPaletteRedForeground1) !important' },
    ':enabled:focus': { color: 'var(--colorPaletteRedForeground1) !important' },
    ':enabled:focus-visible': { color: 'var(--colorPaletteRedForeground1) !important' },
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
  return <Tooltip content={label} relationship="label">
    <Button
      appearance="subtle"
      aria-label={label}
      className={mergeClasses(s.action, danger && s.danger, className)}
      disabled={disabled}
      icon={icon}
      onClick={onClick}
      size="small"
    />
  </Tooltip>;
}
