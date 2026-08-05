import { base64, base64urlnopad } from '@scure/base';

const ASCII_WHITESPACE = /[\t\n\f\r ]/g;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;

export const decodeWebBase64 = (value: string): Uint8Array => {
  return base64.decode(normalizeForgivingBase64(value));
};

export const encodeBase64 = (bytes: Uint8Array): string => base64.encode(bytes);

export const encodeBase64url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);

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
