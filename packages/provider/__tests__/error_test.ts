import { expect, test } from 'vitest';

import { toInternalDebugError } from '../src/error.ts';

test('toInternalDebugError terminates cyclic Error causes with a JSON-safe marker', () => {
  const outer = new Error('outer');
  const inner = new TypeError('inner', { cause: outer });
  outer.cause = inner;

  const debug = toInternalDebugError(outer);
  expect(debug.cause).toMatchObject({
    name: 'TypeError',
    message: 'inner',
    cause: { type: 'circular_reference', name: 'Error', message: 'outer' },
  });
  expect(() => JSON.stringify(debug)).not.toThrow();
});

test('toInternalDebugError bounds adversarially deep Error cause chains', () => {
  let error = new Error('leaf');
  for (let depth = 0; depth < 64; depth++) error = new Error(`depth ${depth}`, { cause: error });

  let cause = toInternalDebugError(error).cause;
  let serializedDepth = 0;
  while (typeof cause === 'object' && cause !== null && !('type' in cause)) {
    serializedDepth++;
    cause = (cause as { cause?: unknown }).cause;
  }
  expect(serializedDepth).toBe(32);
  expect(cause).toMatchObject({ type: 'depth_limit', limit: 32, name: 'Error' });
});

test('toInternalDebugError snapshots stateful non-Error causes exactly once', () => {
  let calls = 0;
  const cause = {
    toJSON: () => ++calls === 1 ? { state: 'captured' } : 1n,
  };

  const debug = toInternalDebugError(new Error('failure', { cause }));
  expect(debug.cause).toEqual({ state: 'captured' });
  expect(calls).toBe(1);
  expect(() => JSON.stringify(debug)).not.toThrow();
});

test('toInternalDebugError does not invoke a hostile fallback toString', () => {
  const cause = {
    toJSON: () => { throw new Error('no JSON'); },
    toString: () => { throw new Error('no string'); },
  };

  const debug = toInternalDebugError(new Error('failure', { cause }));
  expect(debug.cause).toEqual({ type: 'unserializable_cause', valueType: 'object' });
  expect(() => JSON.stringify(debug)).not.toThrow();
});
