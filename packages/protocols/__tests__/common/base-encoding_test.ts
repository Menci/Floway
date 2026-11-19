import { describe, expect, test } from 'vitest';

import {
  decodeForgivingBase64,
  decodeForgivingBase64url,
} from '../../src/common/base-encoding.ts';

describe('base encoding', () => {

  test('implements the Web decoder policy for whitespace and omitted padding', () => {
    expect(decodeForgivingBase64(' Zm9v\nYg\t')).toEqual(new TextEncoder().encode('foob'));
    expect(decodeForgivingBase64url(' -_8=\r\n')).toEqual(new Uint8Array([0xfb, 0xff]));
  });

  test('accepts non-zero trailing padding bits and rejects partial padding', () => {
    expect(new TextDecoder().decode(decodeForgivingBase64('Zh=='))).toBe('f');
    expect(decodeForgivingBase64url('-x')).toEqual(new Uint8Array([0xfb]));
    expect(() => decodeForgivingBase64('Zg=')).toThrow();
  });
});
