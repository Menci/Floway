import { useCallback, useMemo, useRef, useState } from 'react';

export interface DialogInvocation<Value> {
  key: number;
  value: Value;
}

// The invocation outlives the closing: an unmounted surface cannot play the
// exit its motion declares, so the value is kept after `close` and `isOpen` is
// what the dialog is given. A clean form on reopen then rests on the monotonic
// key rather than on the unmount.
export interface DialogControl<Value> {
  close: () => void;
  invocation: DialogInvocation<Value> | null;
  isOpen: boolean;
  open: (value: Value) => void;
}

export const useDialogInvocation = <Value>(): DialogControl<Value> => {
  const nextKey = useRef(0);
  const [invocation, setInvocation] = useState<DialogInvocation<Value> | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback((value: Value) => {
    setInvocation({ key: nextKey.current++, value });
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  // Memoised so a caller can depend on the invocation itself rather than on
  // its parts: the identity then changes exactly when the dialog does.
  return useMemo(() => ({ close, invocation, isOpen, open }), [close, invocation, isOpen, open]);
};
