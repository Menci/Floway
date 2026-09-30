import { appendOpaqueTrailer, decodeOpaqueValue, encodeOpaqueValue, MAX_OPAQUE_TRAILER_BYTES, splitOpaqueTrailer, type OpaqueValueOrigin } from '@floway-dev/protocols/common';

interface CopilotItemIdData {
  version: 1;
  origin: OpaqueValueOrigin;
  id: string;
}

export type DecodedCopilotItemIdCarrier =
  | { kind: 'foreign'; value: string }
  | ({ kind: 'owned'; value: string } & CopilotItemIdData);

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

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
  const original = decodeOpaqueValue(value);
  const metadata = textEncoder.encode(JSON.stringify({
    version: 1,
    origin: original.origin,
    id,
  } satisfies CopilotItemIdData));
  if (metadata.length > MAX_OPAQUE_TRAILER_BYTES) throw new RangeError('Copilot item id metadata exceeds the 2-byte length marker');
  return appendOpaqueTrailer(original, metadata);
};

export const unwrapCopilotItemId = (value: string): DecodedCopilotItemIdCarrier => {
  const framed = splitOpaqueTrailer(value);
  if (framed === null) return { kind: 'foreign', value };

  try {
    const data = parseData(JSON.parse(fatalTextDecoder.decode(framed.trailer)) as unknown);
    if (data === null) return { kind: 'foreign', value };
    return {
      kind: 'owned',
      value: encodeOpaqueValue(framed.original, data.origin),
      ...data,
    };
  } catch {
    return { kind: 'foreign', value };
  }
};
