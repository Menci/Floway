import { decode, encode, Tag } from 'cbor-x';
import mapObject from 'map-obj';

import type { ApiKey } from '../../../../repo/types.ts';
import { decodeCanonicalBase64, decodeCanonicalBase64url, decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';

const SIGNATURE_LENGTH = 32;
const RAW_JSON_TAG = 65_539;
const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => value is { readonly rawJSON: string };
  rawJSON: (text: string) => { readonly rawJSON: string };
};
const key = async (secret: string) => await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const sign = async (data: Uint8Array, secret: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), data as Uint8Array<ArrayBuffer>));
const verify = async (data: Uint8Array, signature: Uint8Array, secret: string): Promise<boolean> => await crypto.subtle.verify('HMAC', await key(secret), signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);

const mapSidecar = (value: unknown, transform: (value: unknown) => unknown): unknown => {
  const mapped = transform(value);
  if (mapped instanceof Tag || mapped instanceof Uint8Array || rawJSON.isRawJSON(mapped)) return mapped;
  if (Array.isArray(mapped)) return mapped.map(child => mapSidecar(child, transform));
  if (typeof mapped === 'object' && mapped !== null) return mapObject(mapped as Record<string, unknown>, (key, child) => [key, mapSidecar(child, transform)]);
  return mapped;
};

const serialize = (obj: unknown): Uint8Array => encode(mapSidecar(obj, value => {
  if (rawJSON.isRawJSON(value)) return new Tag(value.rawJSON, RAW_JSON_TAG);
  if (typeof value === 'string' && value.length >= 22) {
    const decodedBase64 = decodeCanonicalBase64(value);
    if (decodedBase64) return new Tag(decodedBase64, 22);
    const decodedBase64url = decodeCanonicalBase64url(value);
    if (decodedBase64url) return new Tag(decodedBase64url, 21);
  }
  return value;
}));
const deserialize = (buffer: Uint8Array): unknown => mapSidecar(decode(buffer), value => {
  if (value instanceof Tag && value.tag === RAW_JSON_TAG) return rawJSON.rawJSON(value.value as string);
  if (value instanceof Tag && value.tag === 22) return encodeBase64(value.value as Uint8Array);
  if (value instanceof Tag && value.tag === 21) return encodeBase64url(value.value as Uint8Array);
  return value;
});

const encapsulate = async (source: string, sidecar: unknown, apiKey: Pick<ApiKey, 'serverSecret'>): Promise<string> => {
  const data = serialize({ ...sidecar as object, source });
  const signature = await sign(data, apiKey.serverSecret);
  const combined = new Uint8Array(signature.length + data.length);
  combined.set(signature, 0);
  combined.set(data, signature.length);
  return encodeBase64(combined);
};

const unencapsulate = async (source: string, data: unknown, apiKey: Pick<ApiKey, 'serverSecret'>): Promise<unknown | undefined> => {
  if (typeof data !== 'string') return undefined;
  const buffer = decodeForgivingBase64(data);
  const signature = buffer.subarray(0, SIGNATURE_LENGTH);
  const payload = buffer.subarray(SIGNATURE_LENGTH);
  if (!await verify(payload, signature, apiKey.serverSecret)) return undefined;
  try {
    const sidecar = deserialize(payload) as { source: string };
    if (sidecar.source === source) return sidecar;
  } catch {}
  return undefined;
};

export const createAssistantTurnSidecarCodec = (apiKey: Pick<ApiKey, 'serverSecret'>) => ({
  encapsulate: (source: string, value: unknown) => encapsulate(source, value, apiKey),
  unencapsulate: (source: string, data: unknown) => unencapsulate(source, data, apiKey),
});
