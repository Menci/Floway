import {
  decodeCanonicalBase64,
  decodeCanonicalBase64url,
  encodeBase64,
  encodeBase64url,
} from './base-encoding.ts';

export type OpaqueValueOrigin = 'raw' | 'base64' | 'base64url';

export interface DecodedOpaqueValue {
  readonly bytes: Uint8Array;
  readonly origin: OpaqueValueOrigin;
}

export interface SplitOpaqueTrailer {
  readonly original: Uint8Array;
  readonly trailer: Uint8Array;
}

export const MAX_OPAQUE_TRAILER_BYTES = 0xffff;
const LENGTH_MARKER_BYTES = 2;

export const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

export const uint16be = (length: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_OPAQUE_TRAILER_BYTES) {
    throw new RangeError(`Unsigned 16-bit value must be an integer between 0 and ${MAX_OPAQUE_TRAILER_BYTES}: ${length}`);
  }
  return new Uint8Array([length >>> 8, length & 0xff]);
};

export const decodeOpaqueValue = (value: string): DecodedOpaqueValue => {
  if (value.length > 0) {
    const base64 = decodeCanonicalBase64(value);
    if (base64 !== null) return { bytes: base64, origin: 'base64' };
    const base64url = decodeCanonicalBase64url(value);
    if (base64url !== null) return { bytes: base64url, origin: 'base64url' };
  }
  return { bytes: rawStringToBytes(value), origin: 'raw' };
};

export const encodeOpaqueValue = (bytes: Uint8Array, origin: OpaqueValueOrigin): string => {
  switch (origin) {
  case 'base64': return encodeBase64(bytes);
  case 'base64url': return encodeBase64url(bytes);
  case 'raw': return rawStringFromBytes(bytes);
  }
};

export const appendOpaqueTrailer = (
  original: DecodedOpaqueValue | undefined,
  trailer: Uint8Array,
): string => {
  if (trailer.length > MAX_OPAQUE_TRAILER_BYTES) {
    throw new RangeError('Opaque trailer exceeds the 2-byte length marker');
  }
  const framed = concatBytes(original?.bytes ?? new Uint8Array(), trailer, uint16be(trailer.length));
  return original?.origin === 'base64url' ? encodeBase64url(framed) : encodeBase64(framed);
};

export const splitOpaqueTrailer = (value: string, minimumTrailerBytes = 1): SplitOpaqueTrailer | null => {
  if (!Number.isSafeInteger(minimumTrailerBytes) || minimumTrailerBytes < 0 || minimumTrailerBytes > MAX_OPAQUE_TRAILER_BYTES) {
    throw new RangeError(`Minimum opaque trailer length must be an integer between 0 and ${MAX_OPAQUE_TRAILER_BYTES}: ${minimumTrailerBytes}`);
  }
  const framed = decodeCanonicalBase64(value) ?? decodeCanonicalBase64url(value);
  if (framed === null || framed.length < LENGTH_MARKER_BYTES + minimumTrailerBytes) return null;
  const trailerLength = (framed[framed.length - 2] << 8) | framed[framed.length - 1];
  const originalLength = framed.length - LENGTH_MARKER_BYTES - trailerLength;
  if (trailerLength < minimumTrailerBytes || originalLength < 0) return null;
  return {
    original: framed.subarray(0, originalLength),
    trailer: framed.subarray(originalLength, framed.length - LENGTH_MARKER_BYTES),
  };
};

const rawStringToBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit >>> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }
  return bytes;
};

const rawStringFromBytes = (bytes: Uint8Array): string => {
  if (bytes.length % 2 !== 0) throw new TypeError('Raw opaque value has an odd byte length');
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 2) {
    value += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
  }
  return value;
};
