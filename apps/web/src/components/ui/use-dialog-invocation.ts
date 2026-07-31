import { useCallback, useMemo, useRef, useState } from 'react';

export interface DialogInvocation<Value> {
  key: number;
  value: Value;
}

// The invocation outlives the closing. A dialog rendered only while it is open
// is closed by unmounting, and an unmounted surface cannot play the exit its
// motion declares -- it is simply gone on the next frame. So the value is kept
// after `close`, and `isOpen` is what the dialog is given, which leaves the
// surface mounted for as long as Fluent needs to animate it out.
//
// Reopening the same entity still gets a clean form. That guarantee rests on
// the monotonic key, not on the unmount: every `open` mints a new one, so the
// caller's `key` changes and React replaces the subtree whether or not the
// previous instance was still mounted.
export function useDialogInvocation<Value>() {
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
}
