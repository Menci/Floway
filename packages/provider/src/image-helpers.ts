import { base64 } from '@scure/base';

const ASCII_WHITESPACE = /[\t\n\f\r ]/g;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;

export const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  return new Uint8Array(base64.decode(normalizeForgivingBase64(value)));
};

export const bytesToBase64 = (bytes: Uint8Array): string => base64.encode(bytes);

const BASE64_DATA_URL = /^data:([^;,]+)(?:;[^,;]*)*;base64,(.*)$/is;

export const parseBase64ImageDataUrl = (url: string): { mimeType: string; base64: string } | null => {
  const match = BASE64_DATA_URL.exec(url);
  const mimeType = match?.[1];
  const base64 = match?.[2];
  return mimeType?.toLowerCase().startsWith('image/') && base64 !== undefined ? { mimeType, base64 } : null;
};

export const isBase64ImageDataUrl = (url: string): boolean =>
  parseBase64ImageDataUrl(url) !== null;

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
