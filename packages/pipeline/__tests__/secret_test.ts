import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { checkFacts, move } from '../src/facts.ts';
import { Secret } from '../src/index.ts';

describe('Secret', () => {
  it('marks mapped values and exposes the value only explicitly', () => {
    const secret = Secret.from('credential');
    const mapped = secret.map(value => `Bearer ${value}` as const);
    expect(mapped).toBeInstanceOf(Secret);
    expect(mapped.reveal()).toBe('Bearer credential');
    expect(secret.describe()).toEqual({
      length: 10,
      redacted: '**********',
      hash: expect.stringMatching(/^0x[0-9a-f]{16}$/),
    });
    expect(mapped.describe().hash).not.toBe(secret.describe().hash);
    expect(Secret.from('credential').describe()).toEqual(secret.describe());
  });

  it('renders placeholders and uses explicit fact handover', () => {
    const secret = Secret.from('credential');
    expect(JSON.stringify(secret)).toBe('"[Secret]"');
    expect(secret.toString()).toBe('[Secret]');
    expect(String(secret)).toBe('[Secret]');
    expect(inspect(secret)).toBe('[Secret]');
    expect(() => checkFacts({ secret }, 'handoff')).toThrow('"secret" without move()');
    expect(move(secret)).toBe(secret);
    expect(() => checkFacts({ secret }, 'handoff')).not.toThrow();
    expect(Object.isFrozen(secret)).toBe(true);
  });
});
