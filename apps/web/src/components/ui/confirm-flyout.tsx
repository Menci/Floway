import { useId, useState, type ReactElement, type Ref } from 'react';

import { OutcomeMessageBar } from './outcome-message-bar';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Button, Popover, PopoverSurface, PopoverTrigger, Text, Tooltip } = fluentComponents;

export function ConfirmFlyout({ actionLabel, disabled = false, icon, message, onConfirm, title, triggerLabel }: {
  actionLabel: string;
  disabled?: boolean;
  icon: ReactElement;
  message: string;
  onConfirm: () => Promise<string | null>;
  title: string;
  triggerLabel: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (busy || disabled) return;
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
    onOpenChange={(_, data) => { if (!busy) { setOpen(data.open); setTooltipVisible(false); setError(null); } }}
    open={open}
    positioning={{ position: 'below', align: 'end' }}
    trapFocus
  >
    <PopoverTrigger disableButtonEnhancement>{props => <Tooltip
      content={triggerLabel}
      onVisibleChange={(_, data) => setTooltipVisible(!open && data.visible)}
      relationship="label"
      visible={!open && tooltipVisible}
    >
      <Button {...props} as="button" appearance="subtle" aria-label={triggerLabel} disabled={disabled} icon={icon} ref={props.ref as Ref<HTMLButtonElement>} size="small" />
    </Tooltip>}</PopoverTrigger>
    <PopoverSurface aria-labelledby={titleId} className="w-[min(320px,calc(100vw-32px))] grid gap-3 [overflow-wrap:anywhere]">
      <Text id={titleId} weight="semibold">{title}</Text>
      <Text>{message}</Text>
      {error && <OutcomeMessageBar>{error}</OutcomeMessageBar>}
      <div className="flex justify-end gap-2">
        <Button autoFocus disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabledFocusable={busy || disabled} onClick={() => void confirm()}>{actionLabel}</Button>
      </div>
    </PopoverSurface>
  </Popover>;
}
