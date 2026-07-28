import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';

const { Button, Dialog, DialogSurface, DialogTitle, Spinner, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  body: {
    display: 'grid',
    gap: '14px',
    padding: '26px 28px 22px',
  },
  actions: {
    alignItems: 'center',
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    padding: '18px 28px 20px',
    '@media (max-width: 420px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
    },
  },
});

export function ConfirmDialog({
  actionLabel,
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
      <DialogSurface className="overflow-hidden !p-0 !w-[min(430px,calc(100vw-48px))]">
        <div className={s.body}>
          <DialogTitle
            as="h2"
            className="text-fui-fg1 text-fui-base500 font-fui-semibold leading-[1.3] !m-0"
          >
            {title}
          </DialogTitle>
          <p className="text-fui-fg2 text-fui-base300 leading-[1.45] m-0">
            {message}
          </p>
        </div>
        <footer className={`${s.actions} bg-fui-bg2 border-t border-t-solid border-fui-stroke1`}>
          <Button
            appearance="primary"
            className="font-fui-regular my-1 !w-full"
            disabled={busy}
            icon={busy ? <Spinner size="tiny" /> : undefined}
            onClick={onConfirm}
          >
            {actionLabel}
          </Button>
          <Button
            className="font-fui-regular my-1 !w-full"
            disabled={busy}
            onClick={() => {
              if (onCancel) onCancel();
              else onOpenChange(false);
            }}
          >
            {cancelLabel ?? t('common.cancel')}
          </Button>
        </footer>
      </DialogSurface>
    </Dialog>
  );
}
