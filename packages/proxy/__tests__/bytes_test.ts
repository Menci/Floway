import { describe, expect, test } from 'vitest';

import { base64DecodeBytes, base64EncodeBytes, base64UrlDecodeBytes, hexDecode } from '../src/bytes.ts';

describe('base codecs', () => {
  test('matches RFC 4648 vectors and accepts the established external forms', () => {
    expect(base64EncodeBytes(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
    expect(base64DecodeBytes(' Zm9v\nYg\t')).toEqual(new TextEncoder().encode('foob'));
    expect(base64UrlDecodeBytes('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(base64UrlDecodeBytes('/+8=')).toEqual(new Uint8Array([0xff, 0xef]));
    expect(hexDecode('00ABff')).toEqual(new Uint8Array([0x00, 0xab, 0xff]));
  });

  test('preserves forgiving-base64 trailing-bit acceptance for legacy and SS-2022 values', () => {
    expect(new TextDecoder().decode(base64DecodeBytes('Zh=='))).toBe('f');
    expect(new TextDecoder().decode(base64DecodeBytes('MDEyMzQ1Njc4OWFiY2RlZh=='))).toBe('0123456789abcdef');
    expect(base64UrlDecodeBytes('-x')).toEqual(new Uint8Array([0xfb]));
    expect(() => base64DecodeBytes('Zg=')).toThrow();
  });

  test('round-trips a large byte buffer without binary-string conversion', () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index & 0xff);
    expect(base64DecodeBytes(base64EncodeBytes(bytes))).toEqual(bytes);
  });
});
