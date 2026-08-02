import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from './confirm-dialog';
import { useDialogInvocation } from './use-dialog-invocation';

/**
 * Answers every dismissal of a dialog that holds a draft. Esc, the scrim and
 * Cancel all route through `requestClose`, so none of them can be a control
 * that does nothing when pressed, and none of them can throw away an edit the
 * operator has not been asked about.
 */
export const useDiscardGuard = ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const prompt = useDialogInvocation<void>();
  const discarding = useRef(false);

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
