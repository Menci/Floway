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

test('toInternalDebugError preserves every AggregateError branch and its cause chain', () => {
  const parseError = new SyntaxError('invalid payload');
  const primary = new TypeError('stream failed', { cause: parseError });
  const cleanup = new Error('cleanup failed', { cause: { phase: 'return' } });
  const aggregate = new AggregateError([primary, cleanup], 'stream and cleanup failed', { cause: primary });

  const debug = toInternalDebugError(aggregate);
  expect(debug.cause).toMatchObject({
    name: 'TypeError',
    message: 'stream failed',
    stack: primary.stack,
    cause: { name: 'SyntaxError', message: 'invalid payload', stack: parseError.stack },
  });
  expect(debug.errors).toMatchObject([
    {
      type: 'error_reference',
      reference: '$.cause',
    },
    {
      name: 'Error',
      message: 'cleanup failed',
      stack: cleanup.stack,
      cause: { phase: 'return' },
    },
  ]);
  expect(() => JSON.stringify(debug)).not.toThrow();
});

test('toInternalDebugError bounds cyclic and deeply nested AggregateError branches', () => {
  const cyclic = new AggregateError([], 'cyclic');
  cyclic.errors.push(cyclic);

  let deeplyNested: Error = new Error('leaf');
  for (let depth = 0; depth < 64; depth++) deeplyNested = new AggregateError([deeplyNested], `depth ${depth}`);
  const debug = toInternalDebugError(new AggregateError([cyclic, deeplyNested], 'root'));

  expect(debug.errors?.[0]).toMatchObject({
    name: 'AggregateError',
    message: 'cyclic',
    errors: [{ type: 'circular_reference', name: 'AggregateError', message: 'cyclic' }],
  });

  let nested = debug.errors?.[1];
  let serializedDepth = 0;
  while (typeof nested === 'object' && nested !== null && !('type' in nested)) {
    serializedDepth++;
    nested = (nested as { errors?: unknown[] }).errors?.[0];
  }
  expect(serializedDepth).toBe(32);
  expect(nested).toMatchObject({ type: 'depth_limit', limit: 32, name: 'AggregateError' });
  expect(() => JSON.stringify(debug)).not.toThrow();
});

test('toInternalDebugError contains hostile and malformed AggregateError collections', () => {
  const unreadable = new AggregateError([], 'unreadable');
  Object.defineProperty(unreadable, 'errors', {
    get: () => { throw new Error('errors getter failed'); },
  });
  expect(toInternalDebugError(unreadable).errors).toEqual([{ type: 'unreadable_aggregate_errors' }]);

  const malformed = new AggregateError([], 'malformed');
  Object.defineProperty(malformed, 'errors', { value: { 0: new Error('hidden'), length: 1 } });
  expect(toInternalDebugError(malformed).errors).toEqual([{
    type: 'invalid_aggregate_errors',
    valueType: 'object',
  }]);

  const invalidLength = new AggregateError([], 'invalid length');
  const bigintLength = new Proxy([], {
    get: (target, property, receiver) => property === 'length' ? 1n : Reflect.get(target, property, receiver),
  });
  Object.defineProperty(invalidLength, 'errors', { value: bigintLength });
  expect(toInternalDebugError(invalidLength).errors).toEqual([{
    type: 'invalid_aggregate_errors_length',
    valueType: 'bigint',
  }]);

  const first = new Error('first');
  const partiallyUnreadable = new AggregateError([first, new Error('second')], 'partially unreadable');
  Object.defineProperty(partiallyUnreadable.errors, 1, {
    get: () => { throw new Error('entry getter failed'); },
  });
  expect(toInternalDebugError(partiallyUnreadable).errors).toMatchObject([
    { name: 'Error', message: 'first', stack: first.stack },
    { type: 'unreadable_aggregate_error', index: 1 },
  ]);
});

test('toInternalDebugError bounds AggregateError breadth with an explicit marker', () => {
  const errors = Array.from({ length: 40 }, (_, index) => new Error(`branch ${index}`));
  const debug = toInternalDebugError(new AggregateError(errors, 'wide'));

  expect(debug.errors).toHaveLength(33);
  expect(debug.errors?.slice(0, 32).map(error => (error as { message: string }).message)).toEqual(
    Array.from({ length: 32 }, (_, index) => `branch ${index}`),
  );
  expect(debug.errors?.[32]).toEqual({
    type: 'aggregate_errors_truncated',
    limit: 32,
    total: 40,
    omitted: 8,
  });
});

test('toInternalDebugError memoizes shared Error identities across aggregate DAG branches', () => {
  let shared: Error = new Error('leaf');
  for (let depth = 0; depth < 16; depth++) shared = new AggregateError([shared, shared], `depth ${depth}`);

  const debug = toInternalDebugError(shared);
  let current: unknown = debug;
  for (let depth = 0; depth < 16; depth++) {
    const errors = (current as { errors: unknown[] }).errors;
    expect(errors[1]).toMatchObject({ type: 'error_reference' });
    current = errors[0];
  }
  expect(current).toMatchObject({ name: 'Error', message: 'leaf' });
  expect(new TextEncoder().encode(JSON.stringify(debug)).byteLength).toBeLessThan(64 * 1024);
});

test('toInternalDebugError enforces traversal-wide node, string, and output byte ceilings', () => {
  const huge = '🚀'.repeat(100_000);
  const tree = (depth: number): Error => {
    if (depth === 0) return new Error('leaf');
    return new AggregateError(Array.from({ length: 4 }, () => tree(depth - 1)), `node ${depth}`);
  };
  const hugeError = new Error(huge);
  hugeError.stack = huge;

  const debug = toInternalDebugError(new AggregateError([tree(4), hugeError], huge));
  const serialized = JSON.stringify(debug);
  expect(serialized).toMatch(/serialization_node_budget_exhausted|string budget exhausted|truncated/);
  expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(64 * 1024);
});

test('toInternalDebugError contains hostile nested Error properties and revoked proxies', () => {
  const hostile = new Error('hidden');
  for (const property of ['name', 'message', 'stack', 'cause'] as const) {
    Object.defineProperty(hostile, property, {
      get: () => { throw new Error(`${property} getter failed`); },
    });
  }
  const debug = toInternalDebugError(new Error('outer', { cause: hostile }));
  expect(debug.cause).toMatchObject({
    name: '[unreadable Error.name]',
    message: '[unreadable Error.message]',
    stack: '[unreadable Error.stack]',
    cause: { type: 'unreadable_error_property', property: 'cause' },
    unreadable: [
      { type: 'unreadable_error_property', property: 'name' },
      { type: 'unreadable_error_property', property: 'message' },
      { type: 'unreadable_error_property', property: 'stack' },
    ],
  });

  const revocable = Proxy.revocable(new Error('revoked'), {});
  revocable.revoke();
  expect(toInternalDebugError(new Error('outer', { cause: revocable.proxy })).cause).toEqual({
    type: 'unreadable_error_value',
  });

  let prototypeReads = 0;
  const statefulProxy = new Proxy(new Error('stateful'), {
    getPrototypeOf: target => {
      prototypeReads++;
      if (prototypeReads === 1) return Reflect.getPrototypeOf(target);
      throw new Error('prototype getter failed');
    },
  });
  expect(toInternalDebugError(statefulProxy)).toMatchObject({
    type: 'internal_error',
    name: 'Error',
    message: '[unreadable thrown value]',
    cause: { type: 'unreadable_error_value' },
  });
  expect(() => JSON.stringify(debug)).not.toThrow();
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
