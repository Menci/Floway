import { base64 } from '@scure/base';

const ASCII_WHITESPACE = /[\t\n\f\r ]/g;

export const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replace(ASCII_WHITESPACE, '');
  return new Uint8Array(base64.decode(
    normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '='),
  ));
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
