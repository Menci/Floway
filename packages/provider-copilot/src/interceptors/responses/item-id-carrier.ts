type CopilotItemIdOrigin = 'raw' | 'base64' | 'base64url';

interface CopilotItemIdData {
  version: 1;
  origin: CopilotItemIdOrigin;
  id: string;
}

export type DecodedCopilotItemIdCarrier =
  | { kind: 'foreign'; value: string }
  | ({ kind: 'owned'; value: string } & CopilotItemIdData);

const LENGTH_MARKER_BYTES = 2;
const MAX_UINT16 = 0xffff;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const bytesToBase64url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const base64urlToBytes = (value: string): Uint8Array => {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = (4 - standard.length % 4) % 4;
  return base64ToBytes(`${standard}${'='.repeat(padding)}`);
};

const decodeCanonicalBase64 = (value: string): Uint8Array | null => {
  try {
    const bytes = base64ToBytes(value);
    return bytesToBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};

const decodeCanonicalBase64url = (value: string): Uint8Array | null => {
  try {
    const bytes = base64urlToBytes(value);
    return bytesToBase64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
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
  if (bytes.length % 2 !== 0) throw new TypeError('Raw Copilot item carrier has an odd byte length');
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 2) {
    value += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
  }
  return value;
};

const decodeOriginal = (value: string): { bytes: Uint8Array; origin: CopilotItemIdOrigin } => {
  if (value.length > 0) {
    const base64 = decodeCanonicalBase64(value);
    if (base64 !== null) return { bytes: base64, origin: 'base64' };
    const base64url = decodeCanonicalBase64url(value);
    if (base64url !== null) return { bytes: base64url, origin: 'base64url' };
  }
  return { bytes: rawStringToBytes(value), origin: 'raw' };
};

const encodeOriginal = (bytes: Uint8Array, origin: CopilotItemIdOrigin): string => {
  switch (origin) {
  case 'base64': return bytesToBase64(bytes);
  case 'base64url': return bytesToBase64url(bytes);
  case 'raw': return rawStringFromBytes(bytes);
  }
};

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const uint16be = (length: number): Uint8Array =>
  new Uint8Array([length >>> 8, length & 0xff]);

const readTrailingUint16be = (bytes: Uint8Array): number =>
  (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];

const parseData = (value: unknown): CopilotItemIdData | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || record.version !== 1
    || (record.origin !== 'raw' && record.origin !== 'base64' && record.origin !== 'base64url')
    || typeof record.id !== 'string'
    || record.id.length === 0
  ) return null;
  return { version: 1, origin: record.origin, id: record.id };
};

export const wrapCopilotItemId = (value: string, id: string): string => {
  if (id.length === 0) throw new TypeError('Cannot carry an empty Copilot item id');
  const original = decodeOriginal(value);
  const metadata = textEncoder.encode(JSON.stringify({
    version: 1,
    origin: original.origin,
    id,
  } satisfies CopilotItemIdData));
  if (metadata.length > MAX_UINT16) throw new RangeError('Copilot item id metadata exceeds the 2-byte length marker');
  const framed = concatBytes(original.bytes, metadata, uint16be(metadata.length));
  return original.origin === 'base64url' ? bytesToBase64url(framed) : bytesToBase64(framed);
};

export const unwrapCopilotItemId = (value: string): DecodedCopilotItemIdCarrier => {
  const framed = decodeCanonicalBase64(value) ?? decodeCanonicalBase64url(value);
  if (framed === null || framed.length < LENGTH_MARKER_BYTES + 1) return { kind: 'foreign', value };

  const metadataLength = readTrailingUint16be(framed);
  const originalLength = framed.length - LENGTH_MARKER_BYTES - metadataLength;
  if (metadataLength === 0 || originalLength < 0) return { kind: 'foreign', value };

  try {
    const metadata = framed.subarray(originalLength, framed.length - LENGTH_MARKER_BYTES);
    const data = parseData(JSON.parse(fatalTextDecoder.decode(metadata)) as unknown);
    if (data === null) return { kind: 'foreign', value };
    return {
      kind: 'owned',
      value: encodeOriginal(framed.subarray(0, originalLength), data.origin),
      ...data,
    };
  } catch {
    return { kind: 'foreign', value };
  }
};
