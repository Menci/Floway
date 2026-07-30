import { useCallback, useRef, useState } from 'react';

export interface DialogInvocation<Value> {
  key: number;
  value: Value;
}

export function useDialogInvocation<Value>() {
  const nextKey = useRef(0);
  const [invocation, setInvocation] = useState<DialogInvocation<Value> | null>(null);
  const open = useCallback((value: Value) => {
    setInvocation({ key: nextKey.current++, value });
  }, []);
  const close = useCallback(() => setInvocation(null), []);
  return { close, invocation, open };
}
