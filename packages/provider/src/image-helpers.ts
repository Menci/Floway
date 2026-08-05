import { decodeForgivingBase64, encodeBase64, isImageMediaType, mediaTypeEssence } from '@floway-dev/protocols/common';

export const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  return new Uint8Array(decodeForgivingBase64(value));
};

export const bytesToBase64 = (bytes: Uint8Array): string => encodeBase64(bytes);

const BASE64_DATA_URL = /^data:([^;,]+)(?:;[^,;]*)*;base64,(.*)$/is;

export const parseBase64ImageDataUrl = (url: string): { mimeType: string; base64: string } | null => {
  const match = BASE64_DATA_URL.exec(url);
  const mimeType = mediaTypeEssence(match?.[1]);
  const base64 = match?.[2];
  return isImageMediaType(mimeType) && mimeType !== null && base64 !== undefined ? { mimeType, base64 } : null;
};

export const isBase64ImageDataUrl = (url: string): boolean =>
  parseBase64ImageDataUrl(url) !== null;
