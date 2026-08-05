import { describe, expect, test } from 'vitest';

import { decodeWebBase64, encodeBase64url } from '../../src/lib/base-encoding';

describe('browser base encoding', () => {
  test('preserves whitespace, omitted padding, and non-zero trailing padding bits', () => {
    expect(new TextDecoder().decode(decodeWebBase64(' Zm9v\nYg\t'))).toBe('foob');
    expect(new TextDecoder().decode(decodeWebBase64('YWVzLTEyOC1nY206cB=='))).toBe('aes-128-gcm:p');
  });

  test('emits unpadded base64url', () => {
    expect(encodeBase64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
});
