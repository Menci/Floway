import { expect, test } from 'vitest';

import { isAbortError } from '../src/abort.ts';

test('isAbortError recognizes runtime and plain-object aborts', () => {
  expect(isAbortError(new DOMException('cancelled', 'AbortError'))).toBe(true);
  expect(isAbortError({ cause: { name: 'AbortError' } })).toBe(true);
});

test('isAbortError traverses finite deep chains and terminates cyclic chains', () => {
  let deeplyWrapped: unknown = new DOMException('cancelled', 'AbortError');
  for (let depth = 0; depth < 512; depth++) deeplyWrapped = { cause: deeplyWrapped };
  expect(isAbortError(deeplyWrapped)).toBe(true);

  const first: { cause?: unknown } = {};
  const second: { cause?: unknown } = { cause: first };
  first.cause = second;
  expect(isAbortError(first)).toBe(false);

  let beyondDynamicBudget: unknown = new DOMException('cancelled', 'AbortError');
  for (let depth = 0; depth < 4097; depth++) {
    beyondDynamicBudget = new Error('wrapper', { cause: beyondDynamicBudget });
  }
  expect(isAbortError(beyondDynamicBudget)).toBe(true);
});

test('isAbortError does not let hostile accessors replace the inspected error', () => {
  const hostileName = Object.defineProperties({}, {
    name: { get: () => { throw new Error('name getter failed'); } },
    cause: { value: new DOMException('cancelled', 'AbortError') },
  });
  expect(isAbortError(hostileName)).toBe(true);

  const hostileCause = Object.defineProperty({}, 'cause', {
    get: () => { throw new Error('cause getter failed'); },
  });
  expect(isAbortError(hostileCause)).toBe(false);
});

test('isAbortError bounds dynamic cause accessors that return fresh objects', () => {
  let reads = 0;
  const freshCause = (): object => Object.defineProperty({}, 'cause', {
    get: () => {
      reads++;
      return freshCause();
    },
  });

  expect(isAbortError(freshCause())).toBe(false);
  expect(reads).toBe(4096);
});
