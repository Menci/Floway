import { describe, expect, it } from 'vitest';

import { isSecret, onSecretCreated, secret, storedSecret } from '../src/index.ts';

describe('secrets', () => {
  it('hashes the rendered value and masks it without plaintext fragments', () => {
    const handle = secret('hello');
    expect(storedSecret(handle)).toEqual({ length: 5, hash: '0x2cf24dba5fb0a30e', redacted: '*****' });
    expect(handle.reveal()).toBe('hello');
    expect(isSecret(handle)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
    const long = storedSecret(secret('a'.repeat(100)));
    expect(long.length).toBe(100);
    expect(long.redacted).toHaveLength(64);
  });

  it('exposes custom rendering to its creation listener', () => {
    const registered: string[] = [];
    onSecretCreated(rendered => registered.push(rendered));
    const input = { field: 'hello' };
    try {
      const handle = secret(input, input => input.field);
      expect(handle.reveal()).toBe(input);
      expect(handle.hash).toBe(secret('hello').hash);
      expect(registered).toEqual(['hello', 'hello']);
    } finally {
      onSecretCreated(null);
    }
  });
});
