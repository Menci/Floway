import { base64, base64urlnopad } from '@scure/base';
import { normalizeForgivingBase64 } from '@floway-dev/protocols/common';

export const decodeWebBase64 = (value: string): Uint8Array => {
  const normalized = normalizeForgivingBase64(value);
  if (hasTypedArrayBase64()) return base64.decode(normalized);
  return bytesFromBinaryString(atob(normalized));
};

export const decodeWebBase64BinaryString = (value: string): string => {
  const normalized = normalizeForgivingBase64(value);
  return hasTypedArrayBase64() ? binaryStringFromBytes(base64.decode(normalized)) : atob(normalized);
};

export const encodeBase64 = (bytes: Uint8Array): string => {
  if (hasTypedArrayBase64()) return base64.encode(bytes);
  return btoa(binaryStringFromBytes(bytes));
};

export const encodeBase64BinaryString = (value: string): string =>
  hasTypedArrayBase64() ? base64.encode(bytesFromBinaryString(value)) : btoa(value);

export const encodeBase64url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);

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
