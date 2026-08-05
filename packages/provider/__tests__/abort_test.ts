import { expect, test } from 'vitest';

import { isAbortError } from '../src/abort.ts';

test('isAbortError recognizes runtime and plain-object aborts without looping on cyclic causes', () => {
  expect(isAbortError(new DOMException('cancelled', 'AbortError'))).toBe(true);
  expect(isAbortError({ cause: { name: 'AbortError' } })).toBe(true);

  const first: { cause?: unknown } = {};
  const second: { cause?: unknown } = { cause: first };
  first.cause = second;
  expect(isAbortError(first)).toBe(false);
});
