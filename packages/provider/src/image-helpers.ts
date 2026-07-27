const BASE64_CHUNK = 0x8000;

export const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
};

const BASE64_DATA_URL = /^data:([^;,]+)(?:;[^,;]*)*;base64,(.*)$/is;

export const parseBase64ImageDataUrl = (url: string): { mimeType: string; base64: string } | null => {
  const match = BASE64_DATA_URL.exec(url);
  const mimeType = match?.[1];
  const base64 = match?.[2];
  return mimeType?.toLowerCase().startsWith('image/') && base64 !== undefined ? { mimeType, base64 } : null;
};

export const isBase64ImageDataUrl = (url: string): boolean =>
  parseBase64ImageDataUrl(url) !== null;
