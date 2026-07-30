import { useTranslation } from 'react-i18next';

import { DialogShell } from './dialog-shell';
import { fluentComponents } from '../../fluent';

const { Button, DialogActions, DialogTitle, Spinner, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  // colorStatusDangerForegroundInverted is the danger hue for use ON an
  // inverted surface, not the label to place on a danger fill; over
  // DangerBackground3 it reads at roughly 1.9:1. The label that belongs on a
  // filled accent-grade surface is the on-brand foreground, which is white in
  // both themes -- as this fill is in both themes.
  danger: {
    backgroundColor: 'var(--colorStatusDangerBackground3) !important',
    color: 'var(--colorNeutralForegroundOnBrand) !important',
    '&:hover': { backgroundColor: 'var(--colorStatusDangerBackground3Hover) !important' },
    '&:active': { backgroundColor: 'var(--colorStatusDangerBackground3Pressed) !important' },
    '&:hover:active': { backgroundColor: 'var(--colorStatusDangerBackground3Pressed) !important' },
  },
});

export function ConfirmDialog({
  actionLabel,
  actionIntent = 'danger',
  busy = false,
  cancelLabel,
  message,
  onCancel,
  onConfirm,
  onOpenChange,
  title,
}: {
  actionLabel: string;
  actionIntent?: 'danger' | 'primary';
  busy?: boolean;
  cancelLabel?: string;
  message: string;
  onCancel?: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  title: string;
}) {
  const { t } = useTranslation();
  const s = useStyles();

  return (
    <DialogShell
      actions={<DialogActions>
        <Button
          className="!whitespace-nowrap"
          disabled={busy}
          onClick={() => {
            if (onCancel) onCancel();
            else onOpenChange(false);
          }}
        >
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button
          appearance="primary"
          className={actionIntent === 'danger' ? s.danger : undefined}
          disabled={busy}
          icon={busy ? <Spinner size="tiny" /> : undefined}
          onClick={onConfirm}
          style={{ whiteSpace: 'nowrap' }}
        >
          {actionLabel}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => !busy && onOpenChange(data.open)}
      surfaceClassName="!w-[min(430px,calc(100vw-48px))]"
      title={<DialogTitle>{title}</DialogTitle>}
    >
      {message}
    </DialogShell>
  );
}
