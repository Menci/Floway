import { base64, base64urlnopad, hex } from '@scure/base';

const ASCII_WHITESPACE = /[\t\n\f\r ]/g;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;

export const utf8Bytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/**
 * Parse a hex string into bytes. Throws on odd length or any non-hex
 * character — `parseInt('zz', 16)` returns NaN which would otherwise
 * silently write the byte slot as 0 and let a typo through wire framing.
 */
export const hexDecode = (s: string): Uint8Array<ArrayBuffer> => {
  return new Uint8Array(hex.decode(s));
};

export const base64EncodeBytes = (bytes: Uint8Array): string => base64.encode(bytes);

export const base64UrlEncodeBytes = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);

/**
 * Base64-decode the inverse of {@link base64EncodeBytes}. Existing proxy URIs
 * accept the Web `atob` input policy: ASCII whitespace and omitted padding.
 */
export const base64DecodeBytes = (s: string): Uint8Array<ArrayBuffer> => {
  return new Uint8Array(base64.decode(normalizeForgivingBase64(s)));
};

export const base64UrlDecodeBytes = (s: string): Uint8Array<ArrayBuffer> =>
  base64DecodeBytes(s.replaceAll('-', '+').replaceAll('_', '/'));

const normalizeForgivingBase64 = (value: string): string => {
  // https://infra.spec.whatwg.org/#forgiving-base64-decode
  let normalized = value.replace(ASCII_WHITESPACE, '');
  if (normalized.length % 4 === 0) {
    normalized = normalized.endsWith('==')
      ? normalized.slice(0, -2)
      : normalized.endsWith('=') ? normalized.slice(0, -1) : normalized;
  }
  const remainder = normalized.length % 4;
  if (remainder === 1) throw new Error('Invalid base64 length');
  if (!BASE64_BODY.test(normalized)) throw new Error('Invalid base64 character');
  if (remainder === 2 || remainder === 3) {
    const index = BASE64_ALPHABET.indexOf(normalized.at(-1)!);
    const canonical = BASE64_ALPHABET[index & (remainder === 2 ? 0x30 : 0x3c)]!;
    normalized = `${normalized.slice(0, -1)}${canonical}`;
  }
  return normalized.padEnd(normalized.length + (4 - remainder) % 4, '=');
};
