import { describe, expect, it } from 'vitest';

import { InvalidFactValueError } from '../src/errors.ts';
import { collectManagedStreams, freezeValue, isRawJson, snapshotTraceValue } from '../src/freeze.ts';
import { secret } from '../src/secret.ts';

class CustomValue {}

describe('freezeValue', () => {
  it('deep-freezes nested plain objects and arrays while preserving shared identity', () => {
    const shared = { value: 1 };
    const root: { left: typeof shared; right: typeof shared; list: object[]; [key: string]: unknown } = {
      left: shared,
      right: shared,
      list: [],
    };
    root.list.push(root);

    expect(freezeValue(root)).toBe(root);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(root.list)).toBe(true);
  });

  it('accepts non-empty Uint8Array values without freezing their storage', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(freezeValue(bytes)).toBe(bytes);
    expect(Object.isFrozen(bytes)).toBe(false);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('preserves intrinsic JSON.rawJSON identity', () => {
    const rawJson = (JSON as typeof JSON & { rawJSON: (value: string) => unknown }).rawJSON('1.25');
    expect(freezeValue(rawJson)).toBe(rawJson);
    expect(isRawJson(rawJson)).toBe(true);
  });

  it('freezes cyclic Error cause chains', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    (first as Error & { cause?: unknown }).cause = second;
    expect(freezeValue(first)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('preserves Secret handles and discovers reachable streams without iterating them', () => {
    const value = secret('hidden');
    expect(freezeValue({ value })).toEqual({ value });
    expect(Object.isFrozen(value)).toBe(true);
    expect(collectManagedStreams({ value: [null] })).toEqual([]);
  });

  it.each([
    new Map(),
    new Set(),
    new Date(),
    new Headers(),
    new URL('https://example.com'),
    new Blob(['x']),
    new ReadableStream(),
    Promise.resolve(1),
    new CustomValue(),
  ])('rejects unsupported object values', value => {
    expect(() => freezeValue(value)).toThrow(InvalidFactValueError);
  });

  it('rejects functions and symbols', () => {
    expect(() => freezeValue(() => 1)).toThrow(InvalidFactValueError);
    expect(() => freezeValue(Symbol('x'))).toThrow(InvalidFactValueError);
  });

  it('snapshots only nested byte leaves while preserving byte-free identity and sharing copies', () => {
    const stable = { value: 1 };
    const bytes = new Uint8Array([1, 2]);
    const shared = { data: bytes };
    const value = { stable, left: shared, right: shared };
    const cache = new WeakMap<object, object>();
    const snapshot = snapshotTraceValue(value, cache);
    expect(snapshot).not.toBe(value);
    expect(snapshot.stable).toBe(stable);
    expect(snapshot.left).toBe(snapshot.right);
    expect(snapshot.left.data).not.toBe(bytes);
    bytes[0] = 9;
    expect([...snapshot.left.data]).toEqual([1, 2]);
    expect(snapshotTraceValue(value, cache)).toBe(snapshot);
  });
});
