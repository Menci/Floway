import { useCallback, useId, useMemo, useRef, useState } from 'react';

export interface DialogInvocation<Value> {
  key: string;
  value: Value;
}

// The value is kept after `close` because an unmounted surface cannot play the
// exit its motion declares. Controller-scoped revisions reset a reopened form
// without colliding with other retained dialogs rendered as siblings.
export interface DialogControl<Value> {
  close: () => void;
  invocation: DialogInvocation<Value> | null;
  isOpen: boolean;
  open: (value: Value) => void;
}

export const useDialogInvocation = <Value>(): DialogControl<Value> => {
  const id = useId();
  const nextKey = useRef(0);
  const [invocation, setInvocation] = useState<DialogInvocation<Value> | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback((value: Value) => {
    setInvocation({ key: `${id}:${nextKey.current++}`, value });
    setIsOpen(true);
  }, [id]);
  const close = useCallback(() => setIsOpen(false), []);
  return useMemo(() => ({ close, invocation, isOpen, open }), [close, invocation, isOpen, open]);
};
