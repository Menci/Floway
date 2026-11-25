import { describe, expect, it } from 'vitest';

import { checkFacts, move } from '../src/facts.ts';

describe('move', () => {
  it('preserves object identity and freezes shared cyclic paths', () => {
    const shared = { value: 1 };
    const root = { shared, self: {} };
    root.self = root;
    expect(move(root)).toBe(root);
    expect(root.self).toBe(root);
    expect(root.shared).toBe(shared);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
    const next = move({ ...root, shared: { ...root.shared, value: 2 } });
    expect(next.self).toBe(root);
    expect(next.shared).toEqual({ value: 2 });
  });

  it('hands over typed array values without copying their bytes', () => {
    const bytes = new Uint8Array([0, 120, 255]);
    expect(move(bytes)).toBe(bytes);
    expect(Object.isFrozen(bytes)).toBe(false);
    expect(() => checkFacts({ bytes }, 'handoff')).not.toThrow();
    expect([...bytes]).toEqual([0, 120, 255]);
  });

  it('requires explicit handover of each fact value root', () => {
    const nested = { value: 1 };
    const root = move({ nested });
    expect(() => checkFacts({ root }, 'handoff')).not.toThrow();
    expect(() => checkFacts({ nested, root }, 'handoff')).toThrow('"nested" without move()');
    expect(() => checkFacts({ nested: move(nested), root, present: undefined }, 'handoff')).not.toThrow();
    expect(() => checkFacts({ root: Object.freeze({}) }, 'handoff')).toThrow('"root" without move()');
  });

  it('leaves abort signals on the scope', () => {
    const signal = new AbortController().signal;
    expect(() => move({ signal })).toThrow('Abort signals belong to the stage scope');
    expect(() => checkFacts({ signal }, 'handoff')).toThrow('"signal" without move()');
  });
});
