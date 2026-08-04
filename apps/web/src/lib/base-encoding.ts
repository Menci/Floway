import { base64, base64urlnopad } from '@scure/base';

const ASCII_WHITESPACE = /[\t\n\f\r ]/g;

export const decodeWebBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(ASCII_WHITESPACE, '');
  return base64.decode(normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '='));
};

export const encodeBase64 = (bytes: Uint8Array): string => base64.encode(bytes);

export const encodeBase64url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);
