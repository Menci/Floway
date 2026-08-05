import { base64, base64urlnopad, hex } from '@scure/base';

const ASCII_WHITESPACE = /[\t\n\f\r ]/g;

// Web `atob` historically accepted ASCII whitespace and omitted padding.
// Persisted password hashes and Responses payloads, plus external image data,
// already depend on that input policy. Canonical output remains RFC 4648.
export const decodeWebBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(ASCII_WHITESPACE, '');
  return base64.decode(normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '='));
};

export const encodeBase64 = (bytes: Uint8Array): string => base64.encode(bytes);

export const decodeWebBase64url = (value: string): Uint8Array =>
  decodeWebBase64(value.replaceAll('-', '+').replaceAll('_', '/'));

export const encodeBase64url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);

export const encodeHex = (bytes: Uint8Array): string => hex.encode(bytes);

export const decodeHex = (value: string): Uint8Array => hex.decode(value);
