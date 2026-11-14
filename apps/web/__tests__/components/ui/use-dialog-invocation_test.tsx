import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useDialogInvocation } from '../../../src/components/ui/use-dialog-invocation';

test('namespaces retained sibling invocations and resets each reopened form', () => {
  const { result } = renderHook(() => ({ first: useDialogInvocation<string>(), second: useDialogInvocation<string>() }));
  act(() => { result.current.first.open('first'); result.current.second.open('second'); });
  const first = result.current.first.invocation!;
  const second = result.current.second.invocation!;
  expect(first.key).not.toBe(second.key);

  act(() => result.current.first.close());
  expect(result.current.first.isOpen).toBe(false);
  expect(result.current.first.invocation).toBe(first);
  expect(result.current.second.invocation).toBe(second);

  act(() => result.current.first.open('reopened'));
  expect(result.current.first.isOpen).toBe(true);
  expect(result.current.first.invocation!.key).not.toBe(first.key);
  expect(result.current.first.invocation!.key).not.toBe(second.key);
  expect(result.current.first.invocation!.value).toBe('reopened');
  expect(result.current.second.invocation).toBe(second);
});
