import { describe, expect, it } from 'vitest';

import { assertHandedOver, move } from '../src/facts.ts';

describe('handover', () => {
  it('deep freezes what enters the record', () => {
    const value = move({ outer: { inner: [1, 2, 3] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.outer)).toBe(true);
    expect(Object.isFrozen(value.outer.inner)).toBe(true);
    expect(() => { (value.outer as { inner: unknown }).inner = []; }).toThrow(TypeError);
  });

  it('accepts a value that was handed over and rejects one that was not', () => {
    const handed = move({ a: 1 });
    expect(() => assertHandedOver('somewhere', handed)).not.toThrow();
    expect(() => assertHandedOver('somewhere', { a: 1 }))
      .toThrow('somewhere: value was not handed over — call move() at the assignment site');
  });

  it('lets primitives through, because only objects can be mutated in place', () => {
    expect(() => assertHandedOver('somewhere', 'a string')).not.toThrow();
    expect(() => assertHandedOver('somewhere', null)).not.toThrow();
    expect(() => assertHandedOver('somewhere', 7)).not.toThrow();
  });

  // `Object.freeze` throws on a buffer view that has elements, so the walk skips typed
  // arrays — which is exactly why `Object.isFrozen` cannot be the gate and a `WeakSet` is.
  it('registers a typed array without freezing it', () => {
    const bytes = move(new Uint8Array([1, 2, 3]));
    expect(Object.isFrozen(bytes)).toBe(false);
    expect(() => assertHandedOver('body', bytes)).not.toThrow();
  });

  it('registers a body nested inside a record', () => {
    const record = move({ 'request.http.body': new Uint8Array([1, 2, 3]) });
    expect(() => assertHandedOver('body', record['request.http.body'])).not.toThrow();
  });

  // The other half of why the gate is a `WeakSet`: a shallow builtin freeze satisfies
  // `Object.isFrozen` while its children stay mutable, so `isFrozen` would pass a value
  // whose interior is still live.
  it('does not mistake a shallow freeze for a handover', () => {
    const shallow = Object.freeze({ inner: { n: 1 } });
    expect(Object.isFrozen(shallow)).toBe(true);
    shallow.inner.n = 2;
    expect(shallow.inner.n).toBe(2);
    expect(() => assertHandedOver('somewhere', shallow)).toThrow('was not handed over');
  });

  it('walks a cycle once', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a['b'] = b;
    expect(() => move(a)).not.toThrow();
    expect(Object.isFrozen(b)).toBe(true);
  });
});
