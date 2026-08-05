import { describe, expect, test } from 'vitest';

import {
  decodeForgivingBase64,
  decodeForgivingBase64url,
  decodeHex,
  encodeBase64,
  encodeBase64url,
  encodeHex,
} from '../../src/common/base-encoding.ts';

describe('base encoding', () => {
  test('matches the RFC 4648 base64, base64url, and lowercase hex vectors', () => {
    const bytes = new TextEncoder().encode('foobar');
    expect(encodeBase64(bytes)).toBe('Zm9vYmFy');
    expect(encodeBase64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(encodeHex(new Uint8Array([0x00, 0xab, 0xff]))).toBe('00abff');
    expect(decodeForgivingBase64('Zm9vYmFy')).toEqual(bytes);
    expect(decodeForgivingBase64url('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(decodeHex('00ABff')).toEqual(new Uint8Array([0x00, 0xab, 0xff]));
  });

  test('implements the Web decoder policy for whitespace and omitted padding', () => {
    expect(decodeForgivingBase64(' Zm9v\nYg\t')).toEqual(new TextEncoder().encode('foob'));
    expect(decodeForgivingBase64url(' -_8=\r\n')).toEqual(new Uint8Array([0xfb, 0xff]));
  });

  test('accepts non-zero trailing padding bits and rejects partial padding', () => {
    expect(new TextDecoder().decode(decodeForgivingBase64('Zh=='))).toBe('f');
    expect(decodeForgivingBase64url('-x')).toEqual(new Uint8Array([0xfb]));
    expect(() => decodeForgivingBase64('Zg=')).toThrow();
  });

  test('round-trips a large byte buffer', () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index & 0xff);
    expect(decodeForgivingBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
