import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';

const { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  danger: {
    backgroundColor: 'var(--colorStatusDangerBackground3)',
    color: 'var(--colorStatusDangerForegroundInverted)',
    '&:hover': { backgroundColor: 'var(--colorStatusDangerBackground3Hover)' },
    '&:active': { backgroundColor: 'var(--colorStatusDangerBackground3Pressed)' },
    '&:hover:active': { backgroundColor: 'var(--colorStatusDangerBackground3Pressed)' },
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
  open,
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
  open: boolean;
  title: string;
}) {
  const { t } = useTranslation();
  const s = useStyles();

  return (
    <Dialog open={open} onOpenChange={(_, data) => !busy && onOpenChange(data.open)}>
      <DialogSurface className="!w-[min(430px,calc(100vw-48px))]">
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>{message}</DialogContent>
          <DialogActions>
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
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
