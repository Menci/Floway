import { useId, useState, type ComponentProps } from 'react';

import { OutcomeMessageBar } from './outcome-message-bar';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Button, Popover, PopoverSurface, PopoverTrigger, Text } = fluentComponents;

export function ConfirmFlyout({ actionLabel, message, onConfirm, title, trigger }: {
  actionLabel: string;
  message: string;
  onConfirm: () => Promise<string | null>;
  title: string;
  trigger: ComponentProps<typeof PopoverTrigger>['children'];
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await onConfirm();
      if (failure !== null) setError(failure);
      else setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return <Popover
    onOpenChange={(_, data) => { if (!busy) { setOpen(data.open); setError(null); } }}
    open={open}
    positioning={{ position: 'below', align: 'end' }}
    trapFocus
  >
    <PopoverTrigger disableButtonEnhancement>{trigger}</PopoverTrigger>
    <PopoverSurface aria-labelledby={titleId} className="w-[min(320px,calc(100vw-32px))] grid gap-3">
      <Text id={titleId} weight="semibold">{title}</Text>
      <Text>{message}</Text>
      {error && <OutcomeMessageBar>{error}</OutcomeMessageBar>}
      <div className="flex justify-end gap-2">
        <Button autoFocus disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabledFocusable={busy} onClick={() => void confirm()}>{actionLabel}</Button>
      </div>
    </PopoverSurface>
  </Popover>;
}
