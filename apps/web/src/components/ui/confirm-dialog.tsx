import { useTranslation } from 'react-i18next';

import { DialogShell } from './dialog-shell';
import { OutcomeMessageBar } from './outcome-message-bar';
import { fluentComponents } from '../../fluent';

const { Button, DialogActions, DialogTitle, Spinner, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  // The danger fill is DangerBackground3, the same #c50f1f in both themes, so
  // its label has to be the foreground for a surface that does not follow the
  // theme. That is StaticInverted, white in both.
  //
  // Not OnBrand, which is the trap here: OnBrand is white in both themes in
  // stock Fluent, but ../../winui/theme.ts re-points it at WinUI's
  // TextOnAccentFillColorPrimary, and that token is keyed to the accent's own
  // lightness -- white in light, black in dark, because WinUI's dark accent is
  // the lighter blue. On a fill that stays dark red, the dark half of that
  // reads black on red, 3.46:1 at rest and 2.36 pressed.
  //
  // Not DangerForegroundInverted either: that is the danger hue for use ON an
  // inverted surface, not the label to place on a danger fill; over
  // DangerBackground3 it reads at roughly 1.9:1.
  danger: {
    backgroundColor: 'var(--colorStatusDangerBackground3) !important',
    color: 'var(--colorNeutralForegroundStaticInverted) !important',
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
  const styles = useStyles();

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
          className={actionIntent === 'danger' ? styles.danger : undefined}
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
