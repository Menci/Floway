import { describe, expect, test } from 'vitest';

import {
  decodeHex,
  decodeWebBase64,
  decodeWebBase64url,
  encodeBase64,
  encodeBase64url,
  encodeHex,
} from '../../src/shared/base-encoding.ts';

describe('base encoding', () => {
  test('matches the RFC 4648 base64, base64url, and lowercase hex vectors', () => {
    const bytes = new TextEncoder().encode('foobar');
    expect(encodeBase64(bytes)).toBe('Zm9vYmFy');
    expect(encodeBase64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(encodeHex(new Uint8Array([0x00, 0xab, 0xff]))).toBe('00abff');
    expect(decodeWebBase64('Zm9vYmFy')).toEqual(bytes);
    expect(decodeWebBase64url('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(decodeHex('00ABff')).toEqual(new Uint8Array([0x00, 0xab, 0xff]));
  });

  test('preserves the Web decoder policy for legacy whitespace and omitted padding', () => {
    expect(decodeWebBase64(' Zm9v\nYg\t')).toEqual(new TextEncoder().encode('foob'));
    expect(decodeWebBase64url(' -_8=\r\n')).toEqual(new Uint8Array([0xfb, 0xff]));
  });

  test('preserves forgiving-base64 decoding of non-zero trailing padding bits', () => {
    expect(new TextDecoder().decode(decodeWebBase64('Zh=='))).toBe('f');
    expect(decodeWebBase64url('-x')).toEqual(new Uint8Array([0xfb]));
    expect(() => decodeWebBase64('Zg=')).toThrow();
  });

  test('round-trips a buffer larger than JavaScript argument-count limits', () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index & 0xff);
    const decoded = decodeWebBase64(encodeBase64(bytes));
    expect(decoded).toHaveLength(bytes.length);
    expect(decoded.every((byte, index) => byte === bytes[index])).toBe(true);
  });
});
