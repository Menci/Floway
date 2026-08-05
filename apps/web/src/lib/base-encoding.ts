import {
  decodeForgivingBase64,
  encodeBase64 as encodeProtocolBase64,
  encodeBase64url,
  normalizeForgivingBase64,
} from '@floway-dev/protocols/common';

export const decodeWebBase64 = (value: string): Uint8Array => {
  const normalized = normalizeForgivingBase64(value);
  if (hasTypedArrayBase64()) return decodeForgivingBase64(normalized);
  return bytesFromBinaryString(atob(normalized));
};

export const decodeWebBase64BinaryString = (value: string): string => {
  const normalized = normalizeForgivingBase64(value);
  return hasTypedArrayBase64() ? binaryStringFromBytes(decodeForgivingBase64(normalized)) : atob(normalized);
};

export const encodeBase64BinaryString = (value: string): string =>
  hasTypedArrayBase64() ? encodeProtocolBase64(bytesFromBinaryString(value)) : btoa(value);

export { encodeBase64url };

const hasTypedArrayBase64 = (): boolean =>
  typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 === 'function'
  && typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 === 'function';

const bytesFromBinaryString = (value: string): Uint8Array =>
  Uint8Array.from(value, character => character.charCodeAt(0));

const binaryStringFromBytes = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return binary;
};
