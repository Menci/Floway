import { createContext, useCallback, useContext, useId, useMemo, useRef } from 'react';
import type { PropsWithChildren } from 'react';

import { fluentComponents } from '../../fluent';

const { Spinner, Toast, Toaster, ToastTitle, useToastController } = fluentComponents;

// Success only: a failure carries the server's own words and belongs in a hand-dismissed surface next to what failed.

const TOAST_DISMISS_MS = 3000;

interface OutcomeHandle {
  succeed: (message: string) => void;
  /** Drops the pending toast. For a failure, which is reported in place. */
  settle: () => void;
}

export interface OutcomeToasts {
  /** Announces work in flight; the toast stays until the handle settles it. */
  start: (pending: string) => OutcomeHandle;
  succeed: (message: string) => void;
}

const OutcomeToastContext = createContext<OutcomeToasts | null>(null);

export function OutcomeToastProvider({ children }: PropsWithChildren) {
  const toasterId = useId();
  const sequence = useRef(0);
  const { dispatchToast, dismissToast, updateToast } = useToastController(toasterId);

  // Clicking dismisses: Fluent's Toast ships no close button, and waiting out the timeout is the only other exit.
  //
  // A settled toast leaves the media slot unset and carries an intent, which is what makes the appearance layer
  // fill the slot with the InfoBar severity mark. We keep that mark: a surface that dismisses itself in seconds
  // should carry its state without being read.
  const toastFor = useCallback((toastId: string, message: string, pending: boolean) => (
    <Toast className="cursor-pointer" onClick={() => dismissToast(toastId)}>
      <ToastTitle media={pending ? <Spinner size="tiny" /> : undefined}>{message}</ToastTitle>
    </Toast>
  ), [dismissToast]);

  const nextToastId = useCallback(() => `${toasterId}-${sequence.current++}`, [toasterId]);

  const succeed = useCallback((message: string) => {
    const toastId = nextToastId();
    dispatchToast(toastFor(toastId, message, false), { intent: 'success', toastId, timeout: TOAST_DISMISS_MS });
  }, [dispatchToast, nextToastId, toastFor]);

  const start = useCallback((pending: string): OutcomeHandle => {
    const toastId = nextToastId();
    dispatchToast(toastFor(toastId, pending, true), { toastId, timeout: -1 });
    return {
      succeed: message => updateToast({
        content: toastFor(toastId, message, false),
        intent: 'success',
        toastId,
        timeout: TOAST_DISMISS_MS,
      }),
      settle: () => dismissToast(toastId),
    };
  }, [dismissToast, dispatchToast, nextToastId, toastFor, updateToast]);

  const value = useMemo<OutcomeToasts>(() => ({ start, succeed }), [start, succeed]);

  return (
    <OutcomeToastContext.Provider value={value}>
      <Toaster toasterId={toasterId} position="top-end" />
      {children}
    </OutcomeToastContext.Provider>
  );
}

export const useOutcomeToasts = (): OutcomeToasts => {
  const value = useContext(OutcomeToastContext);
  if (!value) throw new Error('useOutcomeToasts requires an OutcomeToastProvider above it');
  return value;
};
