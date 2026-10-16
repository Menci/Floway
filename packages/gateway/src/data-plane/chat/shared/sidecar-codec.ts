import { decode as decodeCBOR, Encoder, Tag } from 'cbor-x';

import { decodeCanonicalBase64, decodeCanonicalBase64url, decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';

export interface SidecarCodec {
  encode: (payload: unknown) => Promise<string>;
  decode: (encoded: string) => Promise<{ payload: unknown } | undefined>;
}

export enum SidecarKind {
  TranslateRoundTrip = 0,
}

export interface SidecarCodecFactory {
  getForKind: (kind: SidecarKind) => SidecarCodec;
}

const SIGNATURE_LENGTH = 32;
const RAW_JSON_TAG = 65_539;
const encoder = new Encoder({ useRecords: false, tagUint8Array: false });
const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => value is { readonly rawJSON: string };
  rawJSON: (text: string) => { readonly rawJSON: string };
};

const mapCBORValue = (value: unknown, transform: (value: unknown) => unknown): unknown => {
  const mapped = transform(value);
  if (mapped instanceof Tag || mapped instanceof Uint8Array || rawJSON.isRawJSON(mapped)) return mapped;
  if (Array.isArray(mapped)) return mapped.map(child => mapCBORValue(child, transform));
  if (typeof mapped === 'object' && mapped !== null) {
    return Object.fromEntries(Object.entries(mapped).map(([key, child]) => [key, mapCBORValue(child, transform)]));
  }
  return mapped;
};

export const encodeCBORValue = (value: unknown): Uint8Array => encoder.encode(mapCBORValue(value, value => {
  if (rawJSON.isRawJSON(value)) return new Tag(value.rawJSON, RAW_JSON_TAG);
  if (typeof value === 'string' && value.length >= 22) {
    const decodedBase64 = decodeCanonicalBase64(value);
    if (decodedBase64) return new Tag(decodedBase64, 22);
    const decodedBase64url = decodeCanonicalBase64url(value);
    if (decodedBase64url) return new Tag(decodedBase64url, 21);
  }
  return value;
}));

const restoreCBORValue = (value: unknown): unknown => mapCBORValue(value, value => {
  if (value instanceof Tag && value.tag === RAW_JSON_TAG) {
    if (typeof value.value !== 'string') throw new TypeError('Raw JSON sidecar tag requires a string');
    return rawJSON.rawJSON(value.value);
  }
  if (value instanceof Tag && value.tag === 22) {
    if (!(value.value instanceof Uint8Array)) throw new TypeError('Base64 sidecar tag requires bytes');
    return encodeBase64(value.value);
  }
  if (value instanceof Tag && value.tag === 21) {
    if (!(value.value instanceof Uint8Array)) throw new TypeError('Base64URL sidecar tag requires bytes');
    return encodeBase64url(value.value);
  }
  return value;
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type AuthenticatedSidecar = Record<string, unknown> & { kind: number };

const hasValidKind = (envelope: Record<string, unknown>): envelope is AuthenticatedSidecar =>
  typeof envelope.kind === 'number' && Number.isInteger(envelope.kind);

export const createSidecarCodecFactory = (secret: string): SidecarCodecFactory => {
  const cryptoKey = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const decodeCache = new Map<string, Promise<AuthenticatedSidecar | undefined>>();
  const decodeEnvelope = async (encoded: string): Promise<AuthenticatedSidecar | undefined> => {
    let buffer: Uint8Array;
    try {
      buffer = decodeForgivingBase64(encoded);
    } catch {
      return undefined;
    }
    const signature = buffer.subarray(0, SIGNATURE_LENGTH);
    const data = buffer.subarray(SIGNATURE_LENGTH);
    if (!await crypto.subtle.verify('HMAC', await cryptoKey, Uint8Array.from(signature), Uint8Array.from(data))) return undefined;
    const envelope: unknown = decodeCBOR(data);
    if (!isRecord(envelope)) throw new TypeError('Authenticated sidecar envelope is invalid');
    if (!hasValidKind(envelope)) throw new TypeError('Authenticated sidecar kind is invalid');
    return envelope;
  };
  return {
    getForKind: kind => ({
      encode: async payload => {
        const data = encodeCBORValue({ kind, payload });
        const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await cryptoKey, Uint8Array.from(data)));
        const combined = new Uint8Array(signature.length + data.length);
        combined.set(signature);
        combined.set(data, signature.length);
        return encodeBase64(combined);
      },
      decode: async encoded => {
        for (;;) {
          let pending = decodeCache.get(encoded);
          if (pending === undefined) {
            pending = decodeEnvelope(encoded);
            decodeCache.set(encoded, pending);
          }
          const envelope = await pending;
          if (envelope?.kind !== kind) return undefined;
          // A matching caller takes the cached object; concurrent callers decode
          // independently after ownership has already been transferred.
          if (decodeCache.get(encoded) !== pending) continue;
          decodeCache.delete(encoded);
          if (!Object.hasOwn(envelope, 'payload')) throw new TypeError('Authenticated sidecar payload is missing');
          return { payload: restoreCBORValue(envelope.payload) };
        }
      },
    }),
  };
};
