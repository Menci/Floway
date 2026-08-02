import { useCallback, useMemo, useRef, useState } from 'react';

export interface DialogInvocation<Value> {
  key: number;
  value: Value;
}

// The value is kept after `close` because an unmounted surface cannot play the
// exit its motion declares; the monotonic key is what resets a reopened form.
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
  return useMemo(() => ({ close, invocation, isOpen, open }), [close, invocation, isOpen, open]);
};
