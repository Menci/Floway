import { describe, expect, test } from 'vitest';

import { decodeWebBase64, decodeWebBase64BinaryString, encodeBase64, encodeBase64url } from '../../src/lib/base-encoding';

describe('browser base encoding', () => {
  test('preserves whitespace, omitted padding, and non-zero trailing padding bits', () => {
    expect(new TextDecoder().decode(decodeWebBase64(' Zm9v\nYg\t'))).toBe('foob');
    expect(new TextDecoder().decode(decodeWebBase64('Zh=='))).toBe('f');
    expect(() => decodeWebBase64('Zg=')).toThrow();
  });

  test('emits unpadded base64url', () => {
    expect(encodeBase64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  test('uses the bulk Web API fallback when typed-array Base64 is unavailable', () => {
    const fromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
    const toBase64 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: undefined });
    Object.defineProperty(Uint8Array.prototype, 'toBase64', { configurable: true, value: undefined });
    try {
      const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index & 0xff);
      const encoded = encodeBase64(bytes);
      expect(decodeWebBase64(encoded)).toEqual(bytes);
      expect(decodeWebBase64BinaryString(encoded).length).toBe(bytes.length);
    } finally {
      if (fromBase64) Object.defineProperty(Uint8Array, 'fromBase64', fromBase64);
      else Reflect.deleteProperty(Uint8Array, 'fromBase64');
      if (toBase64) Object.defineProperty(Uint8Array.prototype, 'toBase64', toBase64);
      else Reflect.deleteProperty(Uint8Array.prototype, 'toBase64');
    }
  });
});
