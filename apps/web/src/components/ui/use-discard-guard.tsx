import { useCallback, useRef, useState } from 'react';

import { ConfirmDialog } from './confirm-dialog';
import { useDialogInvocation } from './use-dialog-invocation';
import { useTranslation } from '../../i18n/translation';

/**
 * Answers every dismissal of a dialog that holds a draft. Esc, the scrim and
 * Cancel all route through `requestClose`, so none of them can be a control
 * that does nothing when pressed, and none of them can throw away an edit the
 * operator has not been asked about.
 *
 * Dirtiness is the draft against the draft this dialog opened with, not
 * react-hook-form's own `isDirty`: these forms write most of their fields
 * through `setValue`, which leaves that flag saying whatever the last caller
 * remembered to ask for. Each dialog is mounted per invocation, so the values
 * of the first render are the ones it opened with.
 */
export const useDiscardGuard = <T,>({ onClose, values }: { onClose: () => void; values: T }) => {
  const { t } = useTranslation();
  const prompt = useDialogInvocation<void>();
  const discarding = useRef(false);
  const [openedWith] = useState(() => JSON.stringify(values));
  const dirty = JSON.stringify(values) !== openedWith;

  const requestClose = useCallback(() => {
    if (dirty) prompt.open(); else onClose();
  }, [dirty, onClose, prompt]);

  // Closing the guarded dialog in the same commit that closes this one would
  // unmount the surface mid-exit, so the discard is done from the exit.
  const discardConfirmation = prompt.invocation && <ConfirmDialog
    actionLabel={t('common.discard.discard')}
    cancelLabel={t('common.discard.keep')}
    key={prompt.invocation.key}
    message={t('common.discard.message')}
    onConfirm={() => { discarding.current = true; prompt.close(); }}
    onExited={() => {
      if (!discarding.current) return;
      discarding.current = false;
      onClose();
    }}
    onOpenChange={open => { if (!open) prompt.close(); }}
    open={prompt.isOpen}
    title={t('common.discard.title')}
  />;

  return { discardConfirmation, requestClose };
};
