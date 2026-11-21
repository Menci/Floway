import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { isSecret, onSecretCreated, secret, storedSecret } from '../src/secret.ts';

describe('secret', () => {
  it('hashes the rendered value stably and masks it without plaintext fragments', () => {
    const value = secret('my-key');
    expect(value.hash).toBe(`0x${bytesToHex(sha256(utf8ToBytes('my-key'))).slice(0, 16)}`);
    expect(storedSecret(value)).toEqual({
      length: 6,
      hash: value.hash,
      redacted: '******',
    });
    expect(JSON.stringify(value)).not.toContain('my-key');
  });

  it('supports a custom renderer for non-string values', () => {
    const value = secret({ token: 'abc' }, rendered => `token:${rendered.token}`);
    expect(value.reveal()).toEqual({ token: 'abc' });
    expect(value.length).toBe(9);
    expect(value.hash).toMatch(/^0x[0-9a-f]{16}$/);
  });

  it('reports the rendered value to a temporary creation listener', () => {
    const seen: string[] = [];
    onSecretCreated(value => seen.push(value));
    try {
      secret('one');
      secret({ value: 2 }, value => String(value.value));
    } finally {
      onSecretCreated(null);
    }
    expect(seen).toEqual(['one', '2']);
  });

  it('freezes the handle and identifies it through its shared brand', () => {
    const value = secret('value');
    expect(isSecret(value)).toBe(true);
    expect(isSecret({ reveal: () => 'value' })).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
  });
});
