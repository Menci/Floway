import { describe, expect, it } from 'vitest';

import { base64DecodeBytes, base64UrlDecodeBytes } from '../src/encoding.ts';

describe('base codecs', () => {
  it('preserves forgiving-base64 trailing-bit acceptance for legacy and SS-2022 values', () => {
    expect(new TextDecoder().decode(base64DecodeBytes('Zh=='))).toBe('f');
    expect(new TextDecoder().decode(base64DecodeBytes('MDEyMzQ1Njc4OWFiY2RlZh=='))).toBe('0123456789abcdef');
    expect(base64UrlDecodeBytes('-x')).toEqual(new Uint8Array([0xfb]));
    expect(() => base64DecodeBytes('Zg=')).toThrow();
  });
});
