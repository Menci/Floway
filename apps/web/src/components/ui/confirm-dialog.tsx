import { useTranslation } from 'react-i18next';

import { DialogShell } from './dialog-shell';
import { OutcomeMessageBar } from './outcome-message-bar';
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
  error,
  message,
  onDismissError,
  onCancel,
  onConfirm,
  onOpenChange,
  open,
  title,
}: {
  actionLabel: string;
  actionIntent?: 'danger' | 'primary';
  busy?: boolean;
  cancelLabel?: string;
  /**
   * A failed attempt at the action, reported here rather than behind the
   * dialog. Without this the caller has nowhere to put it while the dialog is
   * still open, and every delete failure in the app ended up at page level,
   * under the very dialog the operator was looking at.
   */
  error?: string | null;
  message: string;
  onDismissError?: () => void;
  onCancel?: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  const { t } = useTranslation();
  const s = useStyles();

  return (
    <DialogShell
      open={open}
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
      <div className="grid gap-3 min-w-0">
        <span>{message}</span>
        {error && <OutcomeMessageBar onDismiss={onDismissError}>{error}</OutcomeMessageBar>}
      </div>
    </DialogShell>
  );
}
