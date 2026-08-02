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
  // A settled toast leaves the media slot unset and carries an intent, which is what makes Fluent fill the slot
  // with its own filled severity glyph. We keep that glyph: a surface that dismisses itself in seconds should
  // carry its state without being read. WinUI ships no toast, and of its two nearest surfaces only InfoBar
  // carries a severity -- it paints one glyph per severity, and this follows that reading; the glyph already
  // renders in WinUI's SystemFill severity colours, which the toast layer routes onto Fluent's status ramp.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L70-L74
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
