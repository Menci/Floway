import { createContext, useCallback, useContext, useId, useMemo, useRef } from 'react';
import type { PropsWithChildren } from 'react';

import { fluentComponents } from '../../fluent';

const { Spinner, Toast, Toaster, ToastTitle, useToastController } = fluentComponents;

// One toaster for the whole dashboard, and one way to report that an action
// finished. Every page used to own whichever surface it happened to reach for,
// so the same kind of outcome was announced three different ways depending on
// which screen you were on, and thirteen actions announced success by saying
// nothing at all.
//
// The division of labour is by whether the message has to survive being read.
// Success carries nothing the operator needs to keep, so it goes here and
// leaves. Failure carries a server's own words — `callApi` never throws, so
// every failure message in this app is text the server wrote — and belongs in
// a surface the operator dismisses, next to the thing that failed.

const TOAST_DISMISS_MS = 3000;

interface OutcomeHandle {
  /** Replaces the pending toast with a success one that dismisses itself. */
  succeed: (message: string) => void;
  /** Drops the pending toast. For a failure, which is reported in place. */
  settle: () => void;
}

export interface OutcomeToasts {
  /** Announces work in flight; the toast stays until the handle settles it. */
  start: (pending: string) => OutcomeHandle;
  /** Announces a finished action that had no visible in-flight phase. */
  succeed: (message: string) => void;
}

const OutcomeToastContext = createContext<OutcomeToasts | null>(null);

export function OutcomeToastProvider({ children }: PropsWithChildren) {
  const toasterId = useId();
  const sequence = useRef(0);
  const { dispatchToast, dismissToast, updateToast } = useToastController(toasterId);

  const succeed = useCallback((message: string) => {
    dispatchToast(
      <Toast><ToastTitle>{message}</ToastTitle></Toast>,
      { intent: 'success', timeout: TOAST_DISMISS_MS },
    );
  }, [dispatchToast]);

  const start = useCallback((pending: string): OutcomeHandle => {
    const toastId = `${toasterId}-${sequence.current++}`;
    dispatchToast(
      <Toast><ToastTitle media={<Spinner size="tiny" />}>{pending}</ToastTitle></Toast>,
      { toastId, timeout: -1 },
    );
    return {
      succeed: message => updateToast({
        content: <Toast><ToastTitle>{message}</ToastTitle></Toast>,
        intent: 'success',
        toastId,
        timeout: TOAST_DISMISS_MS,
      }),
      settle: () => dismissToast(toastId),
    };
  }, [dismissToast, dispatchToast, toasterId, updateToast]);

  const value = useMemo<OutcomeToasts>(() => ({ start, succeed }), [start, succeed]);

  return (
    <OutcomeToastContext.Provider value={value}>
      <Toaster toasterId={toasterId} position="top-end" />
      {children}
    </OutcomeToastContext.Provider>
  );
}

export function useOutcomeToasts(): OutcomeToasts {
  const value = useContext(OutcomeToastContext);
  if (!value) throw new Error('useOutcomeToasts requires an OutcomeToastProvider above it');
  return value;
}
